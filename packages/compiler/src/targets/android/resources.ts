// App_Resources and project settings applied to the generated Gradle project, as the NativeScript CLI applies them to
// platforms/android (android-project-service and the runtime's app/build.gradle).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { appResourcesDir, copiedAppFiles, productionPlugins, readConfig } from '../resources.ts';

/**
 * App_Resources/Android/src/main/AndroidManifest.xml for the native app: the
 * CLI's `__PACKAGE__` substitution, the runtime's activity as the app's
 * MainActivity, and the runtime's application class and error activity left
 * out (the native app has neither). The package attribute goes: the Gradle
 * project's namespace replaces it.
 */
export function androidManifest(o: { app: string; applicationId: string; activity: string; application?: string }): string | null {
	const file = join(appResourcesDir(o.app), 'Android', 'src', 'main', 'AndroidManifest.xml');
	if (!existsSync(file)) return null;
	let xml = readFileSync(file, 'utf8').replace(/__PACKAGE__/g, o.applicationId);
	xml = xml.replace(/(<manifest\b[^>]*?)\s+package="[^"]*"/, '$1');
	xml = xml.replace(/<activity\b[^>]*android:name="com\.tns\.ErrorReportActivity"[^>]*?(\/>|>[\s\S]*?<\/activity>)\s*/g, '');
	xml = xml.replace(/android:name="com\.tns\.NativeScriptActivity"/g, `android:name="${o.activity}"`);
	xml = xml.replace(/(<application\b[^>]*?)\s+android:name="com\.tns\.NativeScriptApplication"/, '$1');
	const custom = /<application\b[^>]*?android:name="([^"]+)"/.exec(xml);
	if (custom) throw new Error(`${relative(o.app, file)}: the application class ${custom[1]} extends the JavaScript runtime's; a native release has none`);
	// The kit compiled from core starts the app from an application class of the app's, and core's own activity shows it.
	if (o.application) xml = xml.replace(/<application\b/, `<application android:name="${o.application}"`);
	const runtime = /android:name="(com\.tns\.[\w.]+)"/.exec(xml.replaceAll(`android:name="${o.activity}"`, ''));
	if (runtime) throw new Error(`${relative(o.app, file)}: ${runtime[1]} is part of the JavaScript runtime; a native release has none`);
	return xml;
}

/**
 * The production plugins' `platforms/android/AndroidManifest.xml`, prepared for
 * the manifest merger as the CLI's plugin build prepares them (package
 * attribute removed, `__PACKAGE__` substituted), written under `dir`; those in
 * `except` are left to the build that links them.
 */
export function pluginManifests(o: { app: string; applicationId: string; dir: string; except?: Set<string>; stubbed?: ReadonlySet<string> }): string[] {
	rmSync(o.dir, { recursive: true, force: true });
	const out: string[] = [];
	for (const p of productionPlugins(o.app, 'android', o.stubbed)) {
		if (o.except?.has(p.name)) continue;
		const file = join(p.dir, 'platforms', 'android', 'AndroidManifest.xml');
		if (!existsSync(file)) continue;
		const xml = readFileSync(file, 'utf8')
			.replace(/__PACKAGE__/g, o.applicationId)
			.replace(/(<manifest\b[^>]*?)\s+package="[^"]*"/, '$1');
		if (!/<(uses-|permission|application|queries|supports-|compatible-|instrumentation)/.test(xml)) continue;
		const to = join(o.dir, p.name.replace(/^@/, '').replace(/\//g, '_'), 'AndroidManifest.xml');
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, xml);
		out.push(to);
	}
	return out;
}

/** The app folder's files its NativeScript build copies, as assets at `app/`, which the app extracts where `~/` paths resolve. */
export function copyAndroidAppFiles(app: string, appDir: string, assets: string): boolean {
	const files = copiedAppFiles(appDir, readConfig(app).bundler === 'vite');
	for (const f of files) {
		mkdirSync(dirname(join(assets, 'app', f)), { recursive: true });
		copyFileSync(join(appDir, f), join(assets, 'app', f));
	}
	return files.length > 0;
}

/** Fonts in the app folder, as assets at `app/fonts/`, where core reads them. */
export function copyAndroidFonts(appDir: string, assets: string): boolean {
	const fonts = join(appDir, 'fonts');
	if (!existsSync(fonts) || !statSync(fonts).isDirectory()) return false;
	const to = join(assets, 'app', 'fonts');
	mkdirSync(to, { recursive: true });
	for (const f of readdirSync(fonts).sort()) if (/\.(ttf|otf)$/i.test(f)) copyFileSync(join(fonts, f), join(to, f));
	return true;
}
