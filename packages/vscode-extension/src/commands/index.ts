import * as vscode from 'vscode';
import type { PzStudio } from '@pzstudio/cli/api';
import { ExecutePZCommand } from '../util/execute';
import { registerBuildCommand } from './build';
import { registerCleanCommand } from './clean';
import { registerUpdateCommand } from './update';
import { registerNewCommands } from './new';
import { registerAddCommand } from './add';
import { registerDeleteCommand } from './delete';
import { registerRenameCommand } from './rename';
import { registerLangCommand } from './lang';
import { registerModinfoCommand } from './modinfo';
import { registerModStateCommands } from './modstate';
import { registerConfigureCommand } from './configure';
import { registerOpenProjectJsonCommand } from './openProjectJson';

export function registerAllCommands(
    context: vscode.ExtensionContext,
    execute: ExecutePZCommand,
    studio: PzStudio,
): vscode.Disposable[] {
    return [
        registerBuildCommand(execute),
        registerCleanCommand(execute),
        registerUpdateCommand(execute),
        ...registerNewCommands(context, execute),
        registerAddCommand(execute),
        registerDeleteCommand(execute),
        registerRenameCommand(execute),
        registerLangCommand(execute),
        registerModinfoCommand(execute, studio),
        ...registerModStateCommands(execute),
        registerConfigureCommand(execute),
        registerOpenProjectJsonCommand(),
    ];
}
