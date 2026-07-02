/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import {
	Disposable,
	IDisposable,
	MutableDisposable,
	toDisposable,
} from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	ChatConfiguration,
	ChatScrollbarPromptMarkerClickBehavior,
	DEFAULT_CHAT_SCROLLBAR_PROMPT_MARKERS_MAXIMUM,
	MIN_CHAT_SCROLLBAR_PROMPT_MARKERS_MAXIMUM,
} from '../../common/constants.js';
import {
	IChatRequestViewModel,
	IChatResponseViewModel,
	isRequestVM,
	isResponseVM,
} from '../../common/model/chatViewModel.js';
import { ChatTreeItem } from '../chat.js';
import {
	applyScrollbarPromptMarkerClickBehavior,
	getFocusedScrollbarPromptMarkerId,
	type IChatScrollbarPromptMarkerDescriptor,
	getScrollbarPromptMarkerDescriptors,
} from '../actions/chatPromptNavigationActions.js';

/**
 * The host surface that {@link ChatScrollbarPromptMarkerController} depends on.
 * This interface captures the subset of {@link ChatListWidget} methods used by
 * the controller, allowing it to be tested in isolation with a fake host.
 */
export interface IChatScrollbarPromptMarkerHost {
	readonly renderHeight: number;
	getOverviewRulerLayoutInfo(): { parent: HTMLElement; insertBefore: HTMLElement } | undefined;
	getItems(): ChatTreeItem[];
	getVisiblePromptRowId(): string | undefined;
	hasElement(element: ChatTreeItem): boolean;
	isElementInViewport(element: ChatTreeItem): boolean;
	getFocus(): ChatTreeItem[];
	reveal(element: ChatTreeItem, relativeTop?: number): void;
	focusItem(item: ChatTreeItem): void;
}

const MARKER_INLINE_SIZE = 6;
const MARKER_HOVER_INLINE_SIZE = 16;
const MARKER_HITBOX_PADDING = 6;
const MARKER_RESTING_HEIGHT = 2;
const MARKER_HITBOX_HEIGHT = (MARKER_HITBOX_PADDING * 2) + MARKER_RESTING_HEIGHT;
const MAX_PROMPT_HOVER_INLINE_SIZE = 32;
const MARKER_HOVER_BOUNDS_MARGIN = 10;
const MARKER_GUTTER_INLINE_SIZE = 'calc((var(--vscode-spacing-size160) * 2) + var(--vscode-spacing-size80))';

/**
 * Manages the lifecycle, layout, and interaction of scrollbar markers on the
 * chat overview ruler.
 *
 * The controller is responsible for:
	* - Computing stable center-stacked marker positions from descriptor order
 * - Rendering marker DOM elements (reusing existing elements across renders
 *   so CSS transitions can animate position/size changes)
	* - Handling pointer/click events on the overview ruler against the centered
	*   stack hitboxes, including dense-stack nearest-center resolution
 * - Deferring focus to the target chat row after scroll-induced re-renders settle
 */
export class ChatScrollbarPromptMarkerController extends Disposable {
	private readonly container = document.createElement('div');
	private readonly markerById = new Map<string, HTMLElement>();
	private readonly descriptorById = new Map<string, IChatScrollbarPromptMarkerDescriptor>();
	private readonly parentPointerDownListener = this._register(
		new MutableDisposable(),
	);
	private readonly parentClickListener = this._register(
		new MutableDisposable(),
	);
	private readonly parentPointerUpListener = this._register(
		new MutableDisposable(),
	);
	private readonly parentPointerCancelListener = this._register(
		new MutableDisposable(),
	);
	private readonly parentMouseMoveListener = this._register(
		new MutableDisposable(),
	);
	private readonly parentMouseOutListener = this._register(
		new MutableDisposable(),
	);
	private pointerDownListenerParent: HTMLElement | undefined;
	private visible = true;
	private enabled = true;
	private markerActivated = false;
	private suppressNextClick = false;
	private lastDescriptorId: string | undefined;
	private readonly _focusRetryDisposable = this._register(new MutableDisposable());
	private readonly _clickSuppressionDisposable = this._register(new MutableDisposable());

	constructor(
		private readonly host: IChatScrollbarPromptMarkerHost,
		private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(
			toDisposable(() => {
				this.cancelPendingFocusRetries();
				this.container.remove();
			}),
		);
		this.container.classList.add('chat-scrollbar-prompt-markers');
		// The marker overlay is a mouse-only visual aid. It is hidden from the
		// accessibility tree because it has no keyboard interaction path.
		// Keyboard users can navigate prompts via the Next/Previous User Prompt
		// commands, which are documented in the chat accessibility help dialog.
		this.container.setAttribute('aria-hidden', 'true');
		this.container.style.position = 'absolute';
		this.container.style.top = '0';
		this.container.style.bottom = '0';
		this.container.style.pointerEvents = 'none';
		this.container.style.display = 'none';
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.resetHoverState();
			this.resetGestureState();
			this.cancelPendingFocusRetries();
		}
		this.updateContainerVisibility();
	}

	/**
	 * Enable or disable the marker overlay at runtime (e.g. when the
	 * `chat.scrollbarPromptMarkers.enabled` setting changes). When disabled,
	 * the overlay container is hidden and all marker DOM nodes are cleared.
	 * When re-enabled, the overlay is re-laid-out and markers are refreshed.
	 */
	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) {
			return;
		}
		this.enabled = enabled;
		if (!enabled) {
			this.resetHoverState();
			this.resetGestureState();
			this.cancelPendingFocusRetries();
			this.clearMarkers();
			// Fully detach the overlay and dispose the capture listeners on the
			// overview-ruler parent so the feature is a true no-op when disabled.
			// Re-enabling via layout() re-attaches the container and listeners.
			this.detachOverlay();
		}
		this.updateContainerVisibility();
		if (enabled) {
			this.layout();
		}
	}

	layout(): void {
		if (!this.enabled) {
			return;
		}

		const layoutInfo = this.host.getOverviewRulerLayoutInfo();
		if (!layoutInfo) {
			return;
		}

		if (
			this.container.parentElement !== layoutInfo.parent ||
			this.container.nextElementSibling !== layoutInfo.insertBefore
		) {
			layoutInfo.parent.insertBefore(this.container, layoutInfo.insertBefore);
		}

		const scrollbarWidth = Math.max(
			0,
			Math.round(layoutInfo.insertBefore.getBoundingClientRect().width),
		);
		this.container.style.insetInlineEnd = `${scrollbarWidth}px`;
		this.container.style.height = `${this.host.renderHeight}px`;
		this.container.style.width = MARKER_GUTTER_INLINE_SIZE;
		if (this.pointerDownListenerParent !== layoutInfo.parent) {
			this.pointerDownListenerParent = layoutInfo.parent;
			this.parentPointerDownListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				dom.EventType.POINTER_DOWN,
				(event) => this.onOverviewRulerPointerDown(event),
				true,
			);
			this.parentClickListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				dom.EventType.CLICK,
				(event) => this.onOverviewRulerClick(event),
				true,
			);
			this.parentPointerUpListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				dom.EventType.POINTER_UP,
				(event) => this.onOverviewRulerPointerUp(event),
				true,
			);
			this.parentPointerCancelListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				'pointercancel',
				() => this.onOverviewRulerPointerCancel(),
				true,
			);
			this.parentMouseMoveListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				dom.EventType.MOUSE_MOVE,
				event => this.onOverviewRulerMouseMove(event),
				true,
			);
			this.parentMouseOutListener.value = dom.addDisposableListener(
				layoutInfo.parent,
				dom.EventType.MOUSE_OUT,
				event => this.onOverviewRulerMouseOut(event),
				true,
			);
		}
		this.updateContainerVisibility();
		this.renderMarkers();
	}

	refresh(): void {
		this.renderMarkers();
	}

	private updateContainerVisibility(): void {
		const shouldShow = this.visible && this.enabled && this.host.renderHeight > 0;
		this.container.style.display = shouldShow ? '' : 'none';
	}

	/**
	 * Detaches the overlay container from the DOM and disposes the capture
	 * listeners installed on the overview-ruler parent. Used when the marker
	 * feature is disabled so it becomes a true no-op (no DOM presence, no
	 * pointer-event interception). {@link layout} re-attaches both on re-enable.
	 */
	private detachOverlay(): void {
		this.container.remove();
		this.parentPointerDownListener.clear();
		this.parentClickListener.clear();
		this.parentPointerUpListener.clear();
		this.parentPointerCancelListener.clear();
		this.parentMouseMoveListener.clear();
		this.parentMouseOutListener.clear();
		this.pointerDownListenerParent = undefined;
	}

	private cancelPendingFocusRetries(): void {
		this._focusRetryDisposable.clear();
	}

	private clearClickSuppression(): void {
		this.suppressNextClick = false;
		this._clickSuppressionDisposable.clear();
	}

	private resetGestureState(): void {
		this.markerActivated = false;
		this.clearClickSuppression();
	}

	private scheduleFocusRetry(targetWindow: Window, callback: () => void): IDisposable {
		let disposed = false;
		let settled = false;
		const runOnce = () => {
			if (!disposed && !settled) {
				settled = true;
				callback();
			}
		};

		const requestAnimationFrameFn = targetWindow.requestAnimationFrame?.bind(targetWindow)
			?? globalThis.requestAnimationFrame?.bind(globalThis);

		let frameHandle: number | undefined;
		if (typeof requestAnimationFrameFn === 'function') {
			frameHandle = requestAnimationFrameFn(runOnce);
		} else if (typeof queueMicrotask === 'function') {
			queueMicrotask(runOnce);
		} else {
			Promise.resolve().then(runOnce);
		}

		return toDisposable(() => {
			disposed = true;
			if (typeof frameHandle === 'number') {
				if (typeof targetWindow.cancelAnimationFrame === 'function') {
					targetWindow.cancelAnimationFrame(frameHandle);
				} else if (typeof globalThis.cancelAnimationFrame === 'function') {
					globalThis.cancelAnimationFrame(frameHandle);
				}
			}
		});
	}

	private clearMarkers(): void {
		for (const [, marker] of this.markerById) { marker.remove(); }
		this.markerById.clear();
		this.descriptorById.clear();
		this.lastDescriptorId = undefined;
		this.resetHoverState();
	}

	private resetHoverState(): void {
		this.container.classList.remove('chat-scrollbar-prompt-markers-hover');
	}

	private setHoverState(hovered: boolean): void {
		this.container.classList.toggle('chat-scrollbar-prompt-markers-hover', hovered);
	}

	private renderMarkers(): void {
		if (!this.visible || !this.enabled) {
			this.updateContainerVisibility();
			return;
		}

		if (!this.host.getOverviewRulerLayoutInfo()) {
			return;
		}

		const rulerHeight = this.host.renderHeight;
		if (rulerHeight <= 0) {
			for (const [, marker] of this.markerById) { marker.remove(); }
			this.markerById.clear();
			this.descriptorById.clear();
			this.lastDescriptorId = undefined;
			this.updateContainerVisibility();
			return;
		}

		const descriptors = getScrollbarPromptMarkerDescriptors(
			this.host.getItems(),
			Math.max(
				MIN_CHAT_SCROLLBAR_PROMPT_MARKERS_MAXIMUM,
				this.configurationService.getValue<number>(ChatConfiguration.ScrollbarPromptMarkersMaximum) ?? DEFAULT_CHAT_SCROLLBAR_PROMPT_MARKERS_MAXIMUM,
			),
		).filter((descriptor) => this.host.hasElement(descriptor.target));
		const visiblePromptRowId = this.host.getVisiblePromptRowId();
		const focusedMarkerId = this.getFocusedMarkerId();
		const hitboxHeight = Math.min(MARKER_HITBOX_HEIGHT, rulerHeight);
		const stackStride = descriptors.length <= 1
			? 0
			: Math.min(
				MARKER_HITBOX_HEIGHT,
				Math.max((rulerHeight - hitboxHeight) / (descriptors.length - 1), 1),
			);
		const stackHeight = hitboxHeight + (Math.max(descriptors.length - 1, 0) * stackStride);
		const stackTop = Math.max((rulerHeight - stackHeight) / 2, 0);
		const promptHoverWidthById = getPromptHoverWidthById(descriptors);

		const nextMarkerById = new Map<string, HTMLElement>();
		const nextDescriptorById = new Map<string, IChatScrollbarPromptMarkerDescriptor>();

		for (const [index, descriptor] of descriptors.entries()) {
			const top = Math.round(stackTop + (index * stackStride));

			// Reuse existing marker element so CSS transitions can animate position/size changes
			let marker = this.markerById.get(descriptor.id);
			if (!marker) {
				marker = dom.$('.chat-scrollbar-prompt-marker');
				marker.style.position = 'absolute';
				marker.style.pointerEvents = 'auto';
				marker.style.cursor = 'pointer';
				this.container.appendChild(marker);
			}

			marker.dataset.markerId = descriptor.id;
			marker.dataset.requestId = descriptor.request.id;
			marker.dataset.markerType = descriptor.markerType;
			marker.style.top = `${top}px`;
			marker.style.height = `${hitboxHeight}px`;
			marker.style.width = `${MARKER_INLINE_SIZE}px`;
			marker.style.insetInlineEnd = '0';
			marker.style.setProperty('--chat-scrollbar-prompt-marker-hover-width', `${promptHoverWidthById.get(descriptor.id) ?? MARKER_HOVER_INLINE_SIZE}px`);
			marker.style.zIndex = String(descriptor.priority);
			marker.className = `chat-scrollbar-prompt-marker chat-scrollbar-prompt-marker-type-${descriptor.markerType}`;
			marker.classList.toggle(
				'active',
				descriptor.request.id === visiblePromptRowId,
			);
			marker.classList.toggle('focused', descriptor.target.id === focusedMarkerId);
			marker.classList.toggle('in-viewport', this.host.isElementInViewport(descriptor.target));

			nextMarkerById.set(descriptor.id, marker);
			nextDescriptorById.set(descriptor.id, descriptor);
		}

		// Remove stale markers that are no longer present
		for (const [id, marker] of this.markerById) {
			if (!nextMarkerById.has(id)) {
				marker.remove();
			}
		}

		this.markerById.clear();
		for (const [id, marker] of nextMarkerById) {
			this.markerById.set(id, marker);
		}
		this.descriptorById.clear();
		for (const [id, descriptor] of nextDescriptorById) {
			this.descriptorById.set(id, descriptor);
		}
		this.lastDescriptorId = descriptors.at(-1)?.id;
		this.updateContainerVisibility();
	}

	private onOverviewRulerPointerDown(event: PointerEvent): void {
		// Only the primary button activates markers for mouse pointers; touch/pen
		// always go through since they have no button semantics.
		if (event.pointerType === 'mouse' && event.button !== 0) {
			return;
		}

		const target = this.getTargetAtPoint(event.clientX, event.clientY);
		if (!target) {
			return;
		}

		this.resetGestureState();
		this.markerActivated = true;
		event.preventDefault();
		event.stopPropagation();
		this.revealItem(target);
	}

	private onOverviewRulerPointerUp(event: PointerEvent): void {
		if (!this.markerActivated) {
			return;
		}
		// Suppress pointerup so the scrollbar doesn't process it and steal focus,
		// then swallow the follow-on click if it arrives.
		this.markerActivated = false;
		this.suppressNextClick = true;
		this._clickSuppressionDisposable.value = this.scheduleFocusRetry(dom.getWindow(this.container), () => {
			this.suppressNextClick = false;
		});
		event.preventDefault();
		event.stopPropagation();
	}

	private onOverviewRulerPointerCancel(): void {
		// The gesture was interrupted (e.g. OS scroll/zoom takeover, pointer left
		// the page). Drop any armed suppression so a later unrelated pointerup or
		// click is not swallowed.
		this.resetGestureState();
	}

	private onOverviewRulerClick(event: MouseEvent): void {
		if (!this.suppressNextClick) {
			return;
		}
		// Swallow the click that follows pointerdown so the scrollbar doesn't
		// process it and steal focus from the target request.
		this.clearClickSuppression();
		event.preventDefault();
		event.stopPropagation();
	}

	private onOverviewRulerMouseMove(event: MouseEvent): void {
		this.setHoverState(!!this.getTargetAtPoint(event.clientX, event.clientY, true));
	}

	private onOverviewRulerMouseOut(event: MouseEvent): void {
		const targetWindow = dom.getWindow(this.container);
		if (event.relatedTarget instanceof targetWindow.Node && this.pointerDownListenerParent?.contains(event.relatedTarget)) {
			return;
		}

		this.resetHoverState();
	}

	/**
	 * Resolves which chat row a pointer event should navigate to, using the
	 * centered stack hitboxes rather than proportional transcript geometry.
	 *
	 * When compressed stacks cause hitboxes to overlap, the marker whose center
	 * is nearest to the click position wins.
	 */
	private getTargetAtPoint(
		clientX: number,
		clientY: number,
		useExpandedHoverBounds = false,
	): IChatScrollbarPromptMarkerDescriptor | undefined {
		if (!this.visible || this.container.style.display === 'none') {
			return undefined;
		}

		const containerRect = this.container.getBoundingClientRect();
		if (
			clientY < containerRect.top ||
			clientY > containerRect.bottom
		) {
			return undefined;
		}
		if (!useExpandedHoverBounds && (clientX < containerRect.left || clientX > containerRect.right)) {
			return undefined;
		}
		if (useExpandedHoverBounds) {
			const expandedHoverWidth = this.getExpandedHoverWidth();
			const isRtl = this.container.ownerDocument.documentElement.dir === 'rtl';
			const markerLeft = isRtl ? containerRect.left : containerRect.right - expandedHoverWidth;
			const markerRight = isRtl ? containerRect.left + expandedHoverWidth : containerRect.right;
			if (clientX < markerLeft || clientX > markerRight) {
				return undefined;
			}
		}

		const candidates: Array<{ id: string; centerDistance: number }> = [];
		for (const [id, marker] of this.markerById) {
			const top = parseFloat(marker.style.top);
			const height = parseFloat(marker.style.height);
			if (Number.isNaN(top) || Number.isNaN(height)) {
				continue;
			}
			const markerTop = containerRect.top + top;
			const markerBottom = markerTop + height;
			if (clientY < markerTop || clientY > markerBottom) {
				continue;
			}
			const markerCenter = markerTop + (height / 2);
			candidates.push({ id, centerDistance: Math.abs(clientY - markerCenter) });
		}

		if (candidates.length === 0) {
			return undefined;
		}

		candidates.sort((a, b) => a.centerDistance - b.centerDistance);

		return this.descriptorById.get(candidates[0].id);
	}

	private getExpandedHoverWidth(): number {
		let expandedHoverWidth = MARKER_HOVER_INLINE_SIZE;
		for (const marker of this.markerById.values()) {
			const width = parseFloat(marker.style.width);
			const hoverWidth = parseFloat(marker.style.getPropertyValue('--chat-scrollbar-prompt-marker-hover-width'));
			expandedHoverWidth = Math.max(
				expandedHoverWidth,
				Number.isNaN(width) ? 0 : width,
				Number.isNaN(hoverWidth) ? 0 : hoverWidth,
			);
		}

		return expandedHoverWidth + MARKER_HOVER_BOUNDS_MARGIN;
	}

	private getFocusedMarkerId(): string | undefined {
		const focused = this.host.getFocus()[0];
		if (!focused || (!isRequestVM(focused) && !isResponseVM(focused))) {
			return undefined;
		}

		return getFocusedScrollbarPromptMarkerId(focused);
	}

	/**
	 * Reveals and optionally focuses the target chat row. Focus is deferred
	 * across multiple animation frames because revealing a row in a long chat
	 * triggers dynamic height re-measurement in the virtualized tree, which
	 * can steal focus during the re-render cycle. The focus is retried until
	 * the target element is available in the tree or a maximum attempt count
	 * is reached.
	 */
	private revealItem(descriptor: IChatScrollbarPromptMarkerDescriptor): void {
		const item = descriptor.target;
		const behavior =
			this.configurationService.getValue<ChatScrollbarPromptMarkerClickBehavior>(
				ChatConfiguration.ScrollbarPromptMarkerClickBehavior,
			);
		const isInViewport = this.host.isElementInViewport(item);
		const isLastDescriptor = descriptor.id === this.lastDescriptorId;

		if (isInViewport) {
			if (behavior === ChatScrollbarPromptMarkerClickBehavior.RevealAndFocus && this.host.hasElement(item)) {
				this.host.focusItem(item);
			}
			return;
		}

		// For the Reveal behavior, delegate entirely to the shared helper so
		// there is a single source of truth for click behavior. For
		// RevealAndFocus, reveal here but defer focusItem below, because
		// revealing a row in a long chat triggers dynamic height re-measurement
		// in the virtualized tree, which can steal focus during the re-render
		// cycle. The focus is retried across animation frames until the target
		// element is available in the tree or a maximum attempt count is reached.
		if (behavior === ChatScrollbarPromptMarkerClickBehavior.Reveal) {
			this.host.reveal(item, isLastDescriptor ? 0.95 : undefined);
			return;
		}

		this.host.reveal(item, isLastDescriptor ? 0.95 : undefined);
		if (this.host.hasElement(item)) {
			this.host.focusItem(item);
		}
		const targetWindow = dom.getWindow(this.container);
		let attempts = 0;
		const maxAttempts = 10;
		const tryFocus = () => {
			if (this.host.hasElement(item)) {
				this.host.focusItem(item);
				return;
			}
			attempts++;
			if (attempts < maxAttempts) {
				this._focusRetryDisposable.value = this.scheduleFocusRetry(targetWindow, tryFocus);
			}
		};
		this._focusRetryDisposable.value = this.scheduleFocusRetry(targetWindow, tryFocus);
	}
}

function getPromptHoverWidthById(descriptors: ReadonlyArray<ReturnType<typeof getScrollbarPromptMarkerDescriptors>[number]>): Map<string, number> {
	const promptDescriptors = descriptors.filter(descriptor => descriptor.markerType === 'prompt');
	if (promptDescriptors.length === 0) {
		return new Map();
	}

	const promptLengths = promptDescriptors.map(descriptor => descriptor.request.messageText.length);
	const minPromptLength = Math.min(...promptLengths);
	const maxPromptLength = Math.max(...promptLengths);
	const promptLengthRange = Math.max(maxPromptLength - minPromptLength, 1);
	const hoverWidthById = new Map<string, number>();

	for (const descriptor of promptDescriptors) {
		const normalizedLength = (descriptor.request.messageText.length - minPromptLength) / promptLengthRange;
		const hoverWidth = Math.max(
			MARKER_HOVER_INLINE_SIZE,
			Math.round(MARKER_HOVER_INLINE_SIZE + (normalizedLength * (MAX_PROMPT_HOVER_INLINE_SIZE - MARKER_HOVER_INLINE_SIZE))),
		);
		hoverWidthById.set(descriptor.id, hoverWidth);
	}

	return hoverWidthById;
}
