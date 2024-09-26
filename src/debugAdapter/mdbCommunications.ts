/*---------------------------------------------------------
 * Copyright (C) Y@ Technologies. All rights reserved.
 *--------------------------------------------------------*/

'use strict';
import { ChildProcess, spawn } from 'child_process';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Mutex } from 'async-mutex';
import path = require('path');
import fs = require('fs');
import { EventEmitter } from 'stream';
import { debug } from 'console';
import { normalizePath } from '../common/mdbPaths';

enum ConnectionLevel {
	none,
	deviceSet,
	connected,
	programed,
}

enum ConnectionType {
	simulator,
	hardware,
}

export enum HaltReason {
	none,
	halt,
	step,
	next
}

export const haltReasonEventMap = {
	[HaltReason.none]: "stopOnException",
	[HaltReason.next]: "stopOnStep",
	[HaltReason.step]: "stopOnStep",
	[HaltReason.halt]: "stopOnPause"
} as const;

export interface IConnectResult {
	success: boolean,
	message: string,
}

export interface IDebuggerStartResult {
	success: boolean,
	message: string,
}

export interface IBreakpoint {
	id: number;
	line: number;
	file: string;
}
export interface ISetBreakpointResponse extends IBreakpoint {
	verified: boolean;
}

export interface IGetBreakpointResponse extends IBreakpoint {
	enabled: boolean;
	address: number;
}

export interface IGetStackResponse {
	index: number;
	name: string;
	file: string;
	line: number;
}

export enum BreakOnType {
	r,
	w,
	rw,
}

export interface ISetWatchResponse {
	id: number;
	verified: boolean;
	message: string;
}

export interface ILogWriter {
	write(input: string): void;
}

export enum LogLevel {
	wrote,
	read,
	info,
	error,
	important,
}

export interface IProgramerInformation {
	index: number;
	name: string;
	type: string;
	serialNumber: string;
	ipAddress?: string;
}
export interface ISupportedProgramerInformation {
	name: string;
	description: string;
}

/** A helper class for finding all the MPLABX things */
export class MDBCommunications extends EventEmitter {

	private disposed: boolean = false;
	private _mdbProcess: ChildProcess;
	private _mdbLogger: ILogWriter | undefined;
	private _mdbMutex: Mutex = new Mutex();

	private _breakpoints: IBreakpoint[] = [];
	private _haltReason: HaltReason = HaltReason.none;
	private _lastStop?: [string, number];

	private _connectionLevel: ConnectionLevel = ConnectionLevel.none;

	private _emitter: EventEmitter = new EventEmitter();

	private get connectionLevel(): ConnectionLevel {
		return this._connectionLevel;
	}

	private set connectionLevel(value: ConnectionLevel) {
		this._connectionLevel = value;
		switch (value) {
			case ConnectionLevel.none:
				break;
			default:
				this.emit(value.toString());
				break;
		}
	}


	/**
	 * A helper class for all things MPLABX
	 * @param mdbPath Specifies the path to the mdb debugger to use
	 */
	constructor(mdbPath: string, logger?: ILogWriter) {
		super();

		this._mdbLogger = logger;

		// (Windows Compatibility) Trim off quotes if there are any
		mdbPath = mdbPath.replace(/"/g, "",);

		this._mdbProcess = spawn('"' + mdbPath + '"', [], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
		this.logLine(`--- Started Microchip Debugger ---`, LogLevel.info);

		this._mdbProcess.stderr?.on('data', (error) => {
			debug(`MDB ERROR -> ${error}`);
		});

		let msgPart: string = '';
		this._mdbProcess.stdout?.on('data', async (data: String) => {
			let d: string = `${data}`;
			this.log(d, LogLevel.read);

			msgPart += d;
			if (msgPart.match(/Stop at/g)) {
				// Return if message not complete
				if (await this.handleStopAt(msgPart))
					return;
			}
			// Reset message part
			msgPart = '';
		});

		this._mdbProcess.on('close', (code) => {
			this.logLine(`--- Microchip Debugger exited with code ${code} ---`,
				code === 0 ? LogLevel.info : LogLevel.error);
		});

		// Wait for the Microchip Debugger to start up.
		this._mdbMutex.runExclusive(() => this.readResult());
	}

	/** Gets the Microchip Debugger Process */
	private get mdbProcess(): ChildProcess {

		if (this.disposed) {
			throw new Error('Attempted to use MPLAB Assistant after being disposed');
		}

		return this._mdbProcess;
	}

	private log(input: string, logLevel: LogLevel) {
		this._mdbLogger?.write(`${logLevel === LogLevel.error ? '[Error] ' : ''}${input}`);
		this.emit('output', input, LogLevel[logLevel]);
	}

	private logLine(input: string, logLevel: LogLevel) {
		this.log(`${input}\r\n`, logLevel);
	}

	private _write(input: string, level: ConnectionLevel) {
		this.mdbProcess.stdin?.write(input + '\r\n');
		this.logLine(input, LogLevel.wrote);
	}

	/** Writes the given command to the Microchip Debugger
	 * @param input The command to send
	 */
	private write(input: string, level: ConnectionLevel) {
		if (this.connectionLevel >= level) {
			this._mdbMutex.runExclusive(() => {
				this._write(input, level);
			});
		} else {
			this.once(level.toString(), () => this.write(input, level));
		}
	}

	/** Reads a single line from the Microchip Debugger */
	private async readLine(): Promise<string> {
		return new Promise((resolve, reject) => {
			this.mdbProcess.stdout?.once('data', resolve);
		});
	}

	/** Reads the whole response to a command from the Microchip Debugger 
	 * @param until The string to look for that indicates the end of the message
	*/
	private async readResult(until: string = '>'): Promise<string> {

		return new Promise<string>(async (resolve, reject) => {
			this._emitter.on('cancel', reject);

			let result: string = '';
			do {
				result += await this.readLine();
			} while (!result.includes(until));

			this._emitter.off('cancel', reject);

			resolve(result);
		});
	}

	/**
	 * Instructs the current operation to cancel
	 */
	public cancel() {
		this._emitter.emit('cancel');
	}

	/**
	 * Handles a "Stop at" message from output. Swallows responses until entirety of "Stop at" message has been chunked out
	 * @param message The "Stop at" message
	 */
	private async handleStopAt(message: string): Promise<boolean> {
		// const addressRegex = /address:(?<address>0x[0-9a-fA-F]{2,8})/gm;
		const fileRegex = /file:(?<file>.+)/gm;
		const lineRegex = /source line:(?<line>\d+)/gm;

		let matches = message.match(lineRegex);

		// Stop at message may or may not come in a single data or over multiple. 
		// If we don't match the pattern, we need to keep reading and re-parse when a full message has been received.
		if ((matches?.length || 0) < 1) {
			return true;
		}

		// const _address = addressRegex.exec(message)?.groups?.address;
		const file = fileRegex.exec(message)?.groups?.file;
		const line = parseInt(lineRegex.exec(message)?.groups?.line || '-1', 10);

		if (!file || line < 0) { return false; };
		this._lastStop = [file, line];

		// Assume we're setting this correctly and can trust it to early return if the stop is user generated in some sense
		if (this._haltReason !== HaltReason.none) {
			const eventToDispatch = haltReasonEventMap[this._haltReason];
			this.emit(eventToDispatch);
			return false; // Early return, as stopAt otherwise checks exceptions and breakpoints
		}

		// Find potential breakpoint based on file name and line - if this does not exist, it must be an exception.
		const breakpoint = this._breakpoints.find(bp => (normalizePath(bp.file) === normalizePath(file)) && bp.line === line);
		if (!breakpoint) {
			this.emit('stopOnException');
		}

		this.emit('stopOnBreakpoint');
		return false;
	}

	/** Sends a command to the Microchip Debugger and returns the whole response
	 * @param input The command to send to the debugger
	 * @param level The ConnectionLevel required in order for the command to work
	 */
	async query(input: string, level: ConnectionLevel, until: string = '>'): Promise<string> {

		if (this.connectionLevel >= level) {
			return this._mdbMutex.runExclusive(() => {
				// Read off any data that may be sitting in the buffer.
				if (this.mdbProcess.stdout?.readableLength ?? 0 > 0) {
					this.mdbProcess.stdout?.read();
				}

				let result: Promise<string> = this.readResult(until);
				this._write(input, level);

				return result;
			});
		} else {
			return new Promise<string>((resolve, reject) => {
				this._emitter.on('cancel', reject);

				this.once(level.toString(), () => {
					this.query(input, level, until).then(v => resolve);
				});

				this._emitter.off('cancel', reject);
			});
		}
	}

	/** Gets a list of all the attached hardware tools that can program */
	public async getAttachedProgramers(): Promise<IProgramerInformation[]> {

		return this.query("HwTool", ConnectionLevel.none).then((value) => {

			let lines: string[] = value.split('\n');

			// Skip the first line
			lines.shift();

			// Removed the last two elements
			lines.pop();
			lines.pop();

			if (lines.length === 0) {
				return [{
					index: -1,
					name: 'No Programers Found',
					type: '',
					serialNumber: 'None'
				}];
			}
			
			return lines.map((line => {
				let match = line.match(/(?<index>\d+)\s*(?<type>[\w\d]+)\s*(?<serialNumber>[\w\d]+)\s*(?<ipAddress>[\w\/\d]+)\s*(?<name>[\w\d\s]+)/);

				if (match) {
					if (match.groups) {
						return match.groups as unknown as IProgramerInformation;
					} else {
						return { index: 0, name: match[0] ?? 'Unknown', type: '', serialNumber: '' };
					}
				} else {
					return { index: 0, name: 'Unknown', type: '', serialNumber: '' };
				}
			}));
		});
	}

	/** Gets a list of all supported hardware tools that can be used */
	public async getSupportedProgramers(): Promise<ISupportedProgramerInformation[]> {
		return this.query("HwTool Supported", ConnectionLevel.none).then((value) => {

			let lines: string[] = value.split('\n');

			// Skip the first line
			lines.shift();

			// Removed the last two elements
			lines.pop();
			lines.pop();

			return lines.map(line => {

				let cells = line.split('\t');

				return {
					name: cells[0],
					// Take off the parentheses
					description: cells[1].substring(1, cells[1].length - 1)
				};
			});
		});
	}

	public async connect(targetDevice: string, toolSet: string, programMode: boolean, toolSetOptions: object = {}): Promise<ConnectionType> {

		this.write(`Device ${targetDevice}`, ConnectionLevel.none);

		this.connectionLevel = ConnectionLevel.deviceSet;

		// Apply all the tool settings
		if (toolSetOptions) {
			for (const [key, value] of Object.entries(toolSetOptions)) {
				this.query(`set ${key} ${value}`, ConnectionLevel.deviceSet);
			};
		}

		// Connect to the tools
		let message: string = await this.query(`HwTool ${toolSet}${programMode ? ' -p' : ''}`, ConnectionLevel.deviceSet, '>');

		// If message is just the default > output, keep reading. On different platforms, \r\n> may be the case, but we're looking for a longer string anyway.
		if (message.length < 8) {
			message = await this.readResult('>');
		}

		let result: ConnectionType = toolSet === "Sim" ? ConnectionType.simulator : ConnectionType.hardware;

		if (result === ConnectionType.hardware && !message.match(/Target device (.+) found\./)) {
			throw new Error(`Failed to connect to target device ${message.replace(/^\>+|\>+$/g, '').trim()}`);
		}

		this.connectionLevel = ConnectionLevel.connected;

		return result;
	}

	public async startDebugger(targetDevice: string, toolSet: string, elfFile: string, toolSetOptions: object = {}, stopOnEntry = false) {

		if (!fs.existsSync(elfFile)) {
			throw new Error(`Failure to find the given file: ${elfFile}`);
		}

		return this.connect(targetDevice, toolSet, false, toolSetOptions).then(async (connectionType) => {
			// Program the chip
			const programResult = await this.query(`Program "${elfFile}"`, ConnectionLevel.connected);
			if (programResult.match(/Program succeeded\./) || programResult.match(/Programming\/Verify complete/)) {

				this.connectionLevel = ConnectionLevel.programed;

				// Let everyone know initialization has completed.
				this.emit('initCompleted');

			} else {
				throw new Error('Failure to write program to device');
			}
		});
	}

	public clearBreakpoints() {
		this.query('delete', ConnectionLevel.programed).then(() => {
			this._breakpoints = [];
		});
	}

	public clearBreakpoint(id: number) {
		this.query(`delete ${id}`, ConnectionLevel.programed).then(() => {
			this._breakpoints = this._breakpoints.filter(bp => bp.id !== id);
		});
	}

	public async setBreakpoint(file: string, line: bigint): Promise<ISetBreakpointResponse> {

		return this.query(`break ${path.basename(file)}:${line}`, ConnectionLevel.programed).then(response => {
			let r = response.match(/Breakpoint (\d+) at file (.+), line (\d+)\./s);

			if (!r) { return { id: -1, line: -1, verified: false, file }; };

			const breakpoint = { id: parseInt(r[1]), line: parseInt(r[3]), file, verified: true };

			this._breakpoints.push(breakpoint);

			return breakpoint;
		});
	}

	public async getBreakpoints(): Promise<Array<IGetBreakpointResponse> | void> {

		return this.query('info break', ConnectionLevel.programed).then(response => {
			let re = [...response.matchAll(/(\d+)\s*(y|n)\s*(0x[\dA-F]+)\s*at (.*):(\d+)/g)];

			return re.forEach((m, i) => {
				if (m) {
					return {
						id: parseInt(m[1]),
						enabled: m[2] === 'y',
						address: parseInt(m[3]),
						file: m[4],
						line: parseInt(m[5])
					};
				}
			});
		});
	}

	private lastLocals: Array<DebugProtocol.Variable> = [];
	private lastRegisters: Array<DebugProtocol.Variable> = [];
	private lastParameters: Array<DebugProtocol.Variable> = [];
	public async getStack(): Promise<Array<IGetStackResponse> | void> {

		return this.query('backtrace full', ConnectionLevel.programed).then(async response => {

			let localsMatches = [...response.matchAll(/\s+(\w+) = 0x(\d+)/g)];

			this.lastLocals = localsMatches.map((m, i) => {
				return {
					name: m[1],
					value: m[2],
					variablesReference: 0,
				};
			});
			const regs = ['WREG', 'FSR0', 'FSR1', 'FSR2'];
			this.lastRegisters = [];
			for (const regName of regs) {
				const regVal = (await this.query('Print /x ' + regName, ConnectionLevel.programed)).match(/(\w+)=([0-9a-f]+)/);
				if (regVal?.length === 3)
					this.lastRegisters.push({
						name: regName,
						value: '0x' + regVal[2],
						presentationHint: { kind: 'data' },
						variablesReference: 0,
					});
			}
			// TODO: https://marketplace.visualstudio.com/items?itemName=mcu-debug.memory-view

			let parametersMatch = [...response.matchAll(/\s+(\w+)=0x(\d+)/g)];

			this.lastParameters = parametersMatch.map((m, i) => {
				return {
					name: m[1],
					value: m[2],
					presentationHint: { kind: 'data' },
					variablesReference: 0,
				};
			});

			const stackMatches = [...response.matchAll(/#(\d+)\s+([a-zA-z0-9_. ]*) \(\) at\s(.*?):(\d+)/g)];
			const stack: IGetStackResponse[] = [];
			for (let i = 0; i < stackMatches.length; i++) {
				const m = stackMatches[i];
				let index = parseInt(m[1]);
				let filePath = m[3];
				let line = parseInt(m[4]);
				if (!filePath && this._lastStop) {
					filePath = this._lastStop[0];
					line = this._lastStop[1];
				}
				stack[i] = {
					index: index,
					name: m[2],
					file: filePath,
					line: line
				};
			}
			// When using old mplab, backtrace maybe empty
			if (stackMatches.length === 0 && this._lastStop)
				return [{
					index: 0,
					name: 'Unknown',
					file: this._lastStop[0],
					line: this._lastStop[1]
				}];
			return stack;
		});
	}

public get hasRegisters(): boolean {
		return this.lastRegisters.length > 0;
	}

	public get hasLocalVariables(): boolean {
			return this.lastLocals.length > 0;
	}

	public get hasParameters(): boolean {
			return this.lastParameters.length > 0;
		}

	public async getRegisters(): Promise<Array<DebugProtocol.Variable>> {
		return this.lastRegisters;
	}

	public async getLocalVariables(): Promise<Array<DebugProtocol.Variable>> {
		return this.lastLocals;
	}

	public async getParameters(): Promise<Array<DebugProtocol.Variable>> {
		return this.lastParameters;
	}

	public run(): void {
		this._haltReason = HaltReason.none;
		this.write('Run', ConnectionLevel.programed);
	}

	public continue(): void {
		this._haltReason = HaltReason.none;
		this.write('Continue', ConnectionLevel.programed);
	}

	public step(machineInstruction: boolean = false): void {
		this._haltReason = HaltReason.step;
		this.write(machineInstruction ? 'Stepi' : 'Step', ConnectionLevel.programed);
	}

	public next(): void {
		this._haltReason = HaltReason.next;
		this.write('Next', ConnectionLevel.programed);
	}

	public halt(): void {
		this._haltReason = HaltReason.halt;
		this.write('Halt', ConnectionLevel.programed);
	}

	public quit(): void {
		this.dispose();
	}

	public async watch(address: string, breakOnType: BreakOnType, value?: number, passCount?: number): Promise<ISetWatchResponse> {

		var command: string = `Watch ${address} ${breakOnType}`;

		if (typeof value !== 'undefined') {
			command += `:${value}`;
		}

		if (typeof passCount !== 'undefined') {
			command += ` ${passCount}`;
		}

		return this.query(command, ConnectionLevel.programed).then(response => {
			let re = response.match(/Watchpoint (\d+)\./);

			if (re) {
				return {
					verified: true,
					id: re ? parseInt(re[1]) : -1,
					message: response,
				};
			} else {
				return {
					verified: false,
					id: -1,
					message: response,
				};
			}
		});
	}

	public async printVariable(name: string): Promise<DebugProtocol.Variable | undefined> {

		const hexMatch = name.match(/^0x([\dA-Fa-f]+)$/);
		if (hexMatch) {
			name = parseInt(hexMatch[1]).toString();
		}

		return this.query(`Print ${name}`, ConnectionLevel.programed).then(response => {
			const re = response.match(/(\w+)=\n?(\d+)/);

			if (re) {
				return {
					name: re[1],
					value: re[2],
					variablesReference: 0,
				};
			} else {
				return undefined;
			}
		});
	}

	/** Disposes the assistant */
	public dispose() {
		if (!this.disposed && this._mdbProcess) {
			this._write('Quit', ConnectionLevel.none);
		}
		this.disposed = true;
	}
}
