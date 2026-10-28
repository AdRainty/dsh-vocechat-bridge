// Host-owned peer dependencies. Runtime contracts were checked against DSH 0.2.1-rc.3;
// see docs/DSH-API.md. The standalone test runner injects these factories.
declare module '@deepseek-ai/schemastery' { const Schema: any; export default Schema; }
declare module '@deepseek-ai/dsh-llm' { export const createUserMessage: any; }
declare module '@deepseek-ai/dsh-tools' { export const defineTool: any; }
