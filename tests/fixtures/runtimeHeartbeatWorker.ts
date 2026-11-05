import { startRuntimeHeartbeat } from '../../services/runtimeHeartbeat';

startRuntimeHeartbeat(20);
process.on('message', message => {
    if (message === 'block') {
        process.send?.({ type: 'blocking' });
        const end = Date.now() + 250;
        while (Date.now() < end) { /* Synthetic synchronous event-loop stall. */ }
    } else if (message === 'stop') process.exit(0);
});
