# VSLABX (MPLABX Extension)

An extension that enables building, ~~programing~~, and ~~debugging~~ MPLABX
projects from within Visual Studio Code

## VSLABX Prerequisites

* MPLABX v5.40 or greater installed on machine
    * Older installations may work but are not validated

## Build

Building can be started by either using the command `MPLABX: Build Project` from the command pallet or creating setting up a build task in `.vscode/tasks.json`

### MPLABX: Build Project
When called from the command pallet, this command will do the following:
* Scans the current workspace for MPLABX project folders by looking for a `Makefile` contained in a folder that end's with `.X`
    * If more then one MPLABX project folder is found, the user will be prompted to select one of the project folders found
* Invokes MPLABX's make with at the directory of the selected project

### Build Task
To create a build task:
* Create the `.vscode/task.json` file
    * Issue the `Tasks: Run Build Task` command from the command pallet, or by using the build keybinding "ctrl+b"
    * A "No build task configured..." message should appear. Press enter to create to select a task template.
    * Select "create task.json from task template"
    * Select "Others"
* Added the `mplabx`build configuration
    * Clear out the contents `tasks` object (from square bracket open to close)
    * Start typing `mplabx-build` and press enter to insert the following snippet
   ```
    {
        "label": "MPLABX Build",
        "type": "mplabx",
        "task": "build",
        "projectFolder": "${workspaceFolder}",
    }
    ```
    * If the MPLABX project is not the same as the `workspaceFolder` append the rest of the path to the `projectFolder` item e.g. `"${workspaceFolder}\TestProject.X"`
* Save the file
* Run the `Tasks: Run Build Task` command again
    * Press enter to select a build task
* Select "MPLABX Build"
* Now running the build command will build the selected project
