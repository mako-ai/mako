/**
 * The console domain service: access (ACL + folder inheritance), reading
 * (tree, flat list, one console), folders, and mutations. Git is the
 * definition store (apps/workspace-consoles.service.ts); these functions
 * keep the Mongo index and the repo in step for the routes and tools.
 */
export * from "./access";
export * from "./tree";
export * from "./folders";
export * from "./crud";
export { ConsoleManager } from "./manager";
