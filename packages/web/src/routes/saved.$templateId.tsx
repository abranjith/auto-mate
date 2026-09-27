import { Outlet, createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/saved/$templateId')({ component: Outlet });
