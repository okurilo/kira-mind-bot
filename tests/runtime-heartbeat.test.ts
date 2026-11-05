import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import path from 'node:path';
import { startRuntimeHeartbeat } from '../services/runtimeHeartbeat';

test('a standalone process does not start the account IPC heartbeat', () => {
    assert.equal(startRuntimeHeartbeat(), undefined);
});

test('actual worker IPC reports event-loop liveness and pauses during a synchronous stall', async t => {
    const child = fork(path.join(__dirname, 'fixtures/runtimeHeartbeatWorker.ts'), [], {
        execArgv: ['--require', require.resolve('ts-node/register/transpile-only')],
        env: { ...process.env, KIRA_TENANT_ID: 'synthetic-heartbeat-worker' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(async () => { if (child.exitCode === null) { const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await done; } });
    const messages: Array<{ type: string; at: number }> = [];
    child.on('message', (message: any) => { assert.deepEqual(Object.keys(message), ['type']); messages.push({ type: message.type, at: Date.now() }); });
    const until = async (condition: () => boolean) => {
        const end = Date.now() + 6000;
        while (!condition()) { assert.ok(Date.now() < end, 'worker IPC deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await until(() => messages.filter(m => m.type === 'kira-heartbeat').length >= 2);
    child.send('block'); await until(() => messages.some(m => m.type === 'blocking'));
    const blockedAt = messages.find(m => m.type === 'blocking')!.at;
    await until(() => messages.some(m => m.type === 'kira-heartbeat' && m.at >= blockedAt + 200));
    const firstAfterBlock = messages.find(m => m.type === 'kira-heartbeat' && m.at > blockedAt)!;
    assert.ok(firstAfterBlock.at - blockedAt >= 200, 'heartbeat must run on the worker event loop, not a separate thread');
});
