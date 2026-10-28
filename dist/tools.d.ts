import type { Bridge } from './bridge.ts';
import type { DshSessionPort } from './dsh.ts';
type DefineTool = (options: any) => any;
/** Register DSH tools using the actual host defineTool compiler (injected by entry). */
export declare function registerVoceTools(ctx: {
    tools: {
        register(tool: any): any;
    };
}, bridge: Pick<Bridge, 'send' | 'status'>, session: DshSessionPort, defineTool: DefineTool): void;
export {};
