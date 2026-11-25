import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { ComponentStyle } from '@nstudio/nativescript-compiler/adapter-api';

/** Svelte's `compile` from the app's own `svelte/compiler`. */
export type SvelteCompile = (source: string, options: Record<string, unknown>) => { css: { code: string } | null };

/**
 * A Svelte component's `<style>` as the app's Svelte compiles it (`css: 'external'`, scoped by its own analysis),
 * with the scoping class (`.svelte-<hash>`) read as an attribute the component's elements carry: Svelte puts the class
 * only on elements its selectors can match, so the attribute on every element selects the same ones.
 */
export function svelteStyles(path: string, text: string, compile: SvelteCompile, generate: 'dom' | 'client'): { styles: ComponentStyle[]; scope: string | null } {
  const style = /<style([^>]*)>([\s\S]*?)<\/style>/.exec(text);
  if (!style) return { styles: [], scope: null };
  const lang = /\blang=["']?(\w+)/.exec(style[1])?.[1];
  let css = style[2];
  if (lang === 'scss' || lang === 'sass') css = (createRequire(path)('sass') as { compileString(s: string, o: object): { css: string } }).compileString(css, { loadPaths: [dirname(path)], syntax: lang === 'sass' ? 'indented' : 'scss' }).css;
  else if (lang && lang !== 'css') throw new Error(`${path}: <style lang="${lang}"> is not supported in a compiled release yet`);
  const scope = `svelte-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`;
  // Only the markup decides what the selectors match: the scripts are left out, and the style is plain CSS.
  const source = text.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2').replace(style[0], `<style>${css}</style>`);
  const result = compile(source, { filename: path, generate, css: 'external', cssHash: () => scope });
  const code = (result.css?.code ?? '').split(`.${scope}`).join(`[${scope}]`);
  return { styles: code.trim() ? [{ file: `${path}.style0.css`, css: code }] : [], scope };
}

