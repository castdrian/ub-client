import { findInReactTree, findInTree, unitToHex, withoutOpacity } from '@utilities';
import { findByFilePath, findByProps, findStore } from '@api/metro';
import { ImageBackground, StyleSheet } from 'react-native';
import type { Theme } from '@typings/managers/themes';
import type { Resolveable } from '@typings/managers';
import type { Manifest } from '@managers';
import { ManagerKind } from '@constants';
import Addons from '@managers/addons';


class Themes extends Addons<Theme> {
	module: Record<PropertyKey, any>;
	extension: string = 'json';

	constructor() {
		super(ManagerKind.THEMES);
	}

	override initialize() {
		for (const theme of window.UNBOUND_THEMES ?? []) {
			const { manifest, bundle } = theme;

			this.load(bundle, manifest);
		}

		this.module = findByProps('RawColor', 'Theme');
		if (!this.module) {
			return this.logger.error('Failed to find theming module. Themes will not function as expected.');
		}

		this.module._Theme = { ...this.module.Theme };
		this.module._RawColor = { ...this.module.RawColor };

		for (const addon of this.entities.values()) {
			if (addon.registered) continue;
			this.registerValues(addon);
		}

		this.patchColors();
		this.patchChatBackground();
		this.patchThemeStore();

		this.initialized = true;
	}

	override load(bundle: string, manifest: Manifest): Theme {
		const addon = super.load(bundle, manifest);

		if (addon && this.initialized) {
			this.registerValues(addon);
		}

		return addon;
	}

	override enable(entity: Resolveable): Promise<void> {
		const addon = this.resolve(entity);
		if (!addon) return;

		try {
			const prev = this.settings.get('applied', null);
			if (prev) this.stop(prev);

			this.settings.set('applied', addon.id);
			if (!addon.started) this.start(addon);

			this.emit('enabled', addon);
		} catch (e) {
			this.logger.error(`Failed to enable ${addon.data.id}:`, e.message);
		}
	}

	override disable(entity: Resolveable): Promise<void> {
		const addon = this.resolve(entity);
		if (!addon) return;

		try {
			this.settings.set('applied', null);
			if (addon.started) this.stop(addon);

			this.emit('disabled', addon);
		} catch (e) {
			this.logger.error(`Failed to disable ${addon.data.id}:`, e.message);
		}
	}

	override isEnabled(id: string): boolean {
		return this.settings.get('applied', null) == id;
	}

	override handleBundle(bundle: string) {
		return typeof bundle === 'object' ? bundle : JSON.parse(bundle);
	}

	registerValues(theme: Theme) {
		const { Theme, Shadow, SemanticColor } = this.module;
		const { data, instance } = theme;

		const key = data.id.toUpperCase().replace('.', '_');
		Theme[key] = data.id;

		for (const key in Shadow) {
			const value = Shadow[key];
			value[data.id] = instance.shadows?.[key] ?? Shadow[key][instance.type ?? 'darker'];
		}

		for (const key in SemanticColor) {
			const value = SemanticColor[key];
			value[data.id] = instance.shadows?.[key] ?? SemanticColor[key][instance.type ?? 'darker'];
		}

		theme.registered = true;
	}

	parseColor(item: Record<string, any>) {
		if (!item?.value) return item;

		if (item?.type === 'raw') {
			return this.module.RawColor[item.value];
		};

		if (item?.type === 'color') {
			return item.value.replace('transparent', 'rgba(0, 0, 0, 0)');
		}
	}

	patchColors() {
		const { RawColor } = this.module;

		for (const key in RawColor) {
			Object.defineProperty(RawColor, key, {
				configurable: true,
				enumerable: true,
				get: () => {
					const { _RawColor } = this.module;

					const applied = this.settings.get('applied', null);
					if (!applied) return _RawColor[key];

					const theme = this.entities.get(applied);
					if (!theme) return _RawColor[key];

					return theme.instance.raw?.[key] ?? _RawColor[key];
				}
			});
		}

		const InternalResolver = findInTree(this.module, m => m?.resolveSemanticColor);
		if (!InternalResolver) {
			return this.logger.error('Failed to find semantic colour resolver. Themes will not function as expected.');
		}

		this.patcher.instead(InternalResolver, 'resolveSemanticColor', (self, args: [theme: string, ref: { [key: symbol]: string; }], orig) => {
			const [theme, ref, ...rest] = args;

			const entity = this.entities.get(theme);
			if (!entity) return orig.apply(self, args);

			const { instance } = entity;

			const [symbol] = Object.getOwnPropertySymbols(ref);
			const key = ref[symbol];
			const item = instance.semantic?.[key];

			try {
				let color = null;

				if (!item) {
					color = orig.call(self, instance?.type ?? 'darker', ref, ...rest);
				} else {
					color = this.parseColor(item);
				}

				if (key === 'CHAT_BACKGROUND' && typeof instance.background?.opacity === 'number') {
					return (color ?? '#000000') + Math.round(instance.background.opacity * 255).toString(16);
				}

				return item?.opacity ? withoutOpacity(color) + unitToHex(item.opacity) : color;
			} catch (e) {
				this.logger.error('Failed to resolve color:', e);
			}

			return orig.call(this, instance?.type ?? 'darker', ref);
		});
	}

	async patchChatBackground() {
		const { default: Messages } = findByFilePath('components_native/chat/Messages.tsx') ?? {};

		if (Messages) {
			this.patcher.after(Messages, 'render', (_, __, res) => {
				const applied = this.settings.get('applied', null);
				if (!applied) return res;

				const theme = this.entities.get(applied);
				if (!theme || !theme.instance.background) return res;

				const Messages = findInReactTree(res, x =>
					'HACK_fixModalInteraction' in x.props
					&& x.props?.style
				);

				if (Messages) {
					Messages.props.style = StyleSheet.flatten([
						Messages.props.style,
						{ backgroundColor: '#00000000' }
					]);
				}

				const { instance: { background } } = theme;

				return (
					<ImageBackground
						blurRadius={typeof background.blur === 'number' ? background.blur : 0}
						style={{ flex: 1, height: '100%', width: '100%' }}
						source={{ uri: background.url }}
					>
						{res}
					</ImageBackground>
				);
			});
		} else {
			this.logger.error('Failed to find Messages. Theme backgrounds may not function as expected.');
		}
	}

	patchThemeStore() {
		const store = findStore('Theme');
		if (!store) return this.logger.error('Failed to find ThemeStore. Themes will not function as expected.');

		// Traverse prototype to find theme getter.
		const proto = findInTree(store, m => m?.hasOwnProperty('theme'), { walkable: ['__proto__'] });
		if (!proto) return this.logger.error(`Failed to patch theme store. Could not find theme getter in store prototype.`);

		// Back up original theme getter
		const descriptor = Object.getOwnPropertyDescriptor(proto, 'theme');
		Object.defineProperty(proto, '__theme', descriptor);

		// Override theme getter, falling back to the original if no theme is applied.
		Object.defineProperty(proto, 'theme', {
			get: () => {
				const applied = this.settings.get('applied', null);
				if (applied && this.initialized) return applied;

				return store.__theme;
			}
		});

		// On theme change, emit a store change to force all components (mainly RootThemeContextProvider) to access our getter override and update their state.
		this.on('enabled', () => store.emitChange());
		this.on('disabled', () => store.emitChange());
	}
}

export default new Themes();
