import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/** Create a browser router. @returns The generated file-route tree with intent preloading. */
export function makeRouter() { return createRouter({ routeTree, defaultPreload: 'intent' }); }

declare module '@tanstack/react-router' { interface Register { router: ReturnType<typeof makeRouter> } }
