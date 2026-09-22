import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { makeRouter } from './router';
import './design-system/theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('The application mount point is missing.');
const queryClient = new QueryClient();
createRoot(root).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={makeRouter()} /></QueryClientProvider></StrictMode>);
