import * as vscode from 'vscode';
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

export function registerAllCommands(
    context: vscode.ExtensionContext,
    execute: ExecutePZCommand,
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
        registerModinfoCommand(execute),
        ...registerModStateCommands(execute),
        registerConfigureCommand(execute),
    ];
}
