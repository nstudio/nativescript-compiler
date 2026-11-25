// The environment variables the compiler reads are `NS_COMPILED_<NAME>`.

export function compiledEnv(name: 'STACKS' | 'DIAGNOSTICS' | 'TABLE_CACHE' | 'DEBUG_VERIFY'): string | undefined {
	return process.env[`NS_COMPILED_${name}`];
}
