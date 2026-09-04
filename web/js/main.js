import { bootApp } from './ui/app.js';
import { registerPWA } from './pwa.js';

// Importing pwa.js registers beforeinstallprompt immediately.
await registerPWA();
await bootApp();
