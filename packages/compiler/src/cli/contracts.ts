// Declarative command contracts matching `nativescript/contracts` via its cross-bundle Symbol.for markers,
// so the extension loads into any NativeScript CLI 9.1+ without bundling a second copy of the CLI.

export const COMMAND_DEFINITION_MARKER: unique symbol = Symbol.for('nativescript:cli:commandDefinition') as never;
export const INJECTION_TOKEN_NAME: unique symbol = Symbol.for('nativescript:di:injectionTokenName') as never;

export const COMMAND_PRECONDITIONS = Object.defineProperty({}, INJECTION_TOKEN_NAME, {
	value: 'commandPreconditions',
	writable: false,
	enumerable: false,
	configurable: false,
});

export type CliOptionType = 'boolean' | 'string' | 'number' | 'array' | 'object';

export interface CliOptionSpec<TValue = unknown> {
	type: CliOptionType;
	default?: TValue;
	required?: boolean;
	alias?: string | string[];
	hasSensitiveValue?: boolean;
	description?: string;
}

export type CliOptionsSchema = Record<string, CliOptionSpec<any>>;

export type CliOptionValues<TSchema extends CliOptionsSchema> = {
	[K in keyof TSchema]: TSchema[K] extends CliOptionSpec<infer TValue> ? TValue | undefined : unknown;
};

export interface CliParamSpec<TSchema extends CliOptionsSchema = CliOptionsSchema> {
	name: string;
	required?: boolean;
	variadic?: boolean;
	description?: string;
	errorMessage?: string;
	validate?(value: string, context: CliCommandContext<TSchema>): boolean | string | Promise<boolean | string>;
}

export type CliParamsPolicy<TSchema extends CliOptionsSchema = CliOptionsSchema> = 'none' | 'any' | CliParamSpec<TSchema>[];

export interface CliInjector {
	get<T = any>(token: unknown, options?: { optional?: boolean }): T;
}

export interface CliLogger {
	info(formatStr?: any, ...args: any[]): void;
	warn(formatStr?: any, ...args: any[]): void;
	error(formatStr?: any, ...args: any[]): void;
	trace(formatStr?: any, ...args: any[]): void;
}

export interface CliProjectData {
	projectDir: string;
	projectName: string;
	platformsDir: string;
	projectIdentifiers?: { ios?: string; android?: string; [platform: string]: string | undefined };
	initializeProjectData(projectDir?: string): void;
}

export interface CliDevice {
	deviceInfo: {
		identifier: string;
		platform: string;
		displayName?: string;
		type?: string;
	};
	applicationManager: {
		reinstallApplication(appIdentifier: string, packageFile: string, options?: Record<string, unknown>): Promise<void>;
		startApplication(appData: { appId: string; projectName: string; projectDir: string }): Promise<void>;
	};
}

export interface CliDevicesService {
	hasDevices: boolean;
	initialize(data?: { platform?: string; deviceId?: string; skipInferPlatform?: boolean; skipDeviceDetectionInterval?: boolean }): Promise<void>;
	execute<T>(action: (device: CliDevice) => Promise<T>, canExecute?: (device: CliDevice) => boolean, options?: { allowNoDevices?: boolean }): Promise<unknown[]>;
}

export interface CliProvider {
	provide: unknown;
	multi?: boolean;
	useValue?: unknown;
}

export interface CliCommandContext<TSchema extends CliOptionsSchema = CliOptionsSchema> {
	args: string[];
	params: Record<string, string | string[]>;
	options: CliOptionValues<TSchema>;
	injector: CliInjector;
	fail(message: string, options?: { help?: boolean }): never;
}

export interface CliCommandDefinition<TSchema extends CliOptionsSchema = CliOptionsSchema> {
	name: string | readonly string[];
	description?: string;
	options?: TSchema;
	params?: CliParamsPolicy<TSchema>;
	allowUnknownOptions?: boolean;
	disableAnalytics?: boolean;
	enableHooks?: boolean;
	providers?: CliProvider[];
	canExecute?(context: CliCommandContext<TSchema>): boolean | Promise<boolean>;
	run(context: CliCommandContext<TSchema>): void | Promise<void>;
}

export type DefinedCliCommand<TSchema extends CliOptionsSchema = CliOptionsSchema> = CliCommandDefinition<TSchema> & {
	readonly [COMMAND_DEFINITION_MARKER]: true;
};

export const booleanOption = (init: Omit<CliOptionSpec<boolean>, 'type'> = {}): CliOptionSpec<boolean> => ({ ...init, type: 'boolean' });
export const stringOption = (init: Omit<CliOptionSpec<string>, 'type'> = {}): CliOptionSpec<string> => ({ ...init, type: 'string' });
export const objectOption = (init: Omit<CliOptionSpec<unknown>, 'type'> = {}): CliOptionSpec<unknown> => ({ ...init, type: 'object' });

export function provideProject(): CliProvider {
	return {
		provide: COMMAND_PRECONDITIONS,
		multi: true,
		useValue: (context: CliCommandContext) => {
			const projectData = context.injector.get<CliProjectData>('projectData');
			if (typeof projectData.initializeProjectData === 'function') {
				projectData.initializeProjectData();
			}
		},
	};
}

export function defineCommand<TSchema extends CliOptionsSchema = CliOptionsSchema>(definition: CliCommandDefinition<TSchema>): DefinedCliCommand<TSchema> {
	return Object.assign({ ...definition }, { [COMMAND_DEFINITION_MARKER]: true as const });
}
