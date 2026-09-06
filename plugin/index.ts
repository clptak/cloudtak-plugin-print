import type { App } from 'vue';
import { IconPrinter } from '@tabler/icons-vue';
import type { PluginAPI, PluginInstance } from '../../plugin.ts';

/**
 * cloudtak-plugin-print
 *
 * Adds a Print entry to the CloudTAK main menu. The panel draws a sheet box on the
 * map showing exactly what will land on paper, harvests the live style, and hands
 * the job to the render service behind /print-api.
 *
 * The route is registered by NAME rather than path. MainMenuContents pushes a menu
 * item by name unless the string starts with '/', while PluginAPI.menu.add() guards
 * with router.hasRoute(), which only resolves names -- so a path-style route would
 * be rejected before it ever reached the menu.
 */
export default class PrintPlugin implements PluginInstance {
    api: PluginAPI;

    constructor(api: PluginAPI) {
        this.api = api;
    }

    static async install(
        app: App,
        api: PluginAPI,
    ): Promise<PluginInstance> {
        // Routes go in at install rather than enable: the guard in menu.add() runs
        // against the router, so the route has to exist before the menu item can.
        // routes.add() is a no-op when the name is already registered.
        api.routes.add({
            path: 'print',
            name: 'home-menu-print',
            component: () => import('./MenuPrint.vue'),
        }, 'home-menu');

        return new PrintPlugin(api);
    }

    async enable(): Promise<void> {
        this.api.menu.add({
            key: 'print',
            label: 'Print',
            route: 'home-menu-print',
            tooltip: 'Print Map',
            description: 'Generate a print-quality PDF map',
            icon: IconPrinter,
        });
    }

    async disable(): Promise<void> {
        this.api.menu.remove('print');
    }
}
