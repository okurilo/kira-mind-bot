import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** Each storefront gets a private Xauthority cookie; no TCP display or shared unauthenticated X server. */
export function xAuthority(display: number, host: string, cookie: Buffer): Buffer {
    const field = (value: Buffer) => { const size = Buffer.alloc(2); size.writeUInt16BE(value.length); return Buffer.concat([size, value]); };
    const family = Buffer.alloc(2); family.writeUInt16BE(256); // FamilyLocal
    return Buffer.concat([family, field(Buffer.from(host)), field(Buffer.from(String(display))), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]);
}

export interface CommerceDisplay { env: NodeJS.ProcessEnv; close(): Promise<void> }

/** Ordinary Chromium can complete the merchant's own browser challenge. This does not solve a CAPTCHA. */
export async function startCommerceDisplay(): Promise<CommerceDisplay> {
    const directory = await fs.mkdtemp('/tmp/kira-display-');
    await fs.chmod(directory, 0o700);
    const authority = path.join(directory, 'authority');
    const display = randomInt(100, 30000);
    await fs.writeFile(authority, xAuthority(display, os.hostname(), randomBytes(16)), { mode: 0o600, flag: 'wx' });
    let child: ChildProcess | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
        if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
            child.kill('SIGTERM');
            const timer = setTimeout(() => child?.kill('SIGKILL'), 2000); timer.unref();
            await exited; clearTimeout(timer);
        }
        await fs.rm(directory, { recursive: true, force: true });
    })();
    try {
        child = spawn('Xvfb', [`:${display}`, '-screen', '0', '1365x900x24', '-nolisten', 'tcp', '-auth', authority], {
            stdio: 'ignore', env: { PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: directory },
        });
        const started = child;
        let failed = false;
        started.once('error', () => { failed = true; });
        for (let attempt = 0; attempt < 50; attempt++) {
            if (failed || started.exitCode !== null || started.signalCode !== null) throw new Error('Не удалось запустить защищённый дисплей магазина.');
            const ready = await fs.stat(`/tmp/.X11-unix/X${display}`).then(() => true, () => false);
            if (ready) return { env: { DISPLAY: `:${display}`, XAUTHORITY: authority }, close };
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Истекло время запуска защищённого дисплея магазина.');
    } catch (error) { await close(); throw error; }
}
