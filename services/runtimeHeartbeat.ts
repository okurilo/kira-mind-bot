/** A timer on the worker's own event loop, independent of Telegram and AI providers. */
export function startRuntimeHeartbeat(intervalMs = 5000): NodeJS.Timeout | undefined {
    if (!process.env.KIRA_TENANT_ID || !process.send || !process.connected) return;
    const send = () => {
        if (!process.connected) return;
        try { process.send?.({ type: 'kira-heartbeat' }, () => {}); }
        catch { /* Parent disconnect has a separate shutdown handler. */ }
    };
    send();
    const timer = setInterval(send, intervalMs);
    timer.unref();
    return timer;
}
