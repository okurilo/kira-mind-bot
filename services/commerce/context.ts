import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolContext } from '../../orchestration/runtime/types';

const invocation = new AsyncLocalStorage<{ context: ToolContext; approvedOperation?: string }>();
export function withCommerceContext<T>(context: ToolContext, approvedOperation: string | undefined, work: () => T): T {
    return invocation.run({ context, approvedOperation }, work);
}
export function commerceInvocation() { return invocation.getStore(); }
