export type AnimationDirection = 1 | -1;
export type AnimationSegment = [number, number];
export type AnimationEventName = 'drawnFrame' | 'enterFrame' | 'loopComplete' | 'complete' | 'segmentStart' | 'destroy' | 'config_ready' | 'data_ready' | 'DOMLoaded' | 'error' | 'data_failed' | 'loaded_images';
export type AnimationEventCallback<T = any> = (args: T) => void;

/** Specifies the data for each event type. */
export interface AnimationEvents {
  DOMLoaded: undefined;
  complete: BMCompleteEvent;
  config_ready: undefined;
  data_failed: undefined;
  data_ready: undefined;
  destroy: BMDestroyEvent;
  drawnFrame: BMEnterFrameEvent;
  enterFrame: BMEnterFrameEvent;
  error: undefined;
  loaded_images: undefined;
  loopComplete: BMCompleteLoopEvent;
  segmentStart: BMSegmentStartEvent;
}

export interface BMCompleteEvent {
  direction: number;
  type: "complete";
}

export interface BMCompleteLoopEvent {
  currentLoop: number;
  direction: number;
  totalLoops: number;
  type: "loopComplete";
}

export interface BMDestroyEvent {
  type: "destroy";
}

export interface BMEnterFrameEvent {
  /** The current time in frames. */
  currentTime: number;
  direction: number;
  /** The total number of frames. */
  totalTime: number;
  type: "enterFrame";
}

export interface BMSegmentStartEvent {
  firstFrame: number;
  totalFrames: number;
  type: "segmentStart";
}

export type AnimationItem = {
    name: string;
    isLoaded: boolean;
    currentFrame: number;
    currentRawFrame: number;
    firstFrame: number;
    totalFrames: number;
    frameRate: number;
    frameMult: number;
    playSpeed: number;
    playDirection: number;
    playCount: number;
    isPaused: boolean;
    autoplay: boolean;
    loop: boolean | number;
    renderer: any;
    animationID: string;
    assetsPath: string;
    timeCompleted: number;
    segmentPos: number;
    isSubframeEnabled: boolean;
    segments: AnimationSegment | AnimationSegment[];
    play(name?: string): void;
    stop(name?: string): void;
    togglePause(name?: string): void;
    destroy(name?: string): void;
    pause(name?: string): void;
    goToAndStop(value: number | string, isFrame?: boolean, name?: string): void;
    goToAndPlay(value: number | string, isFrame?: boolean, name?: string): void;
    includeLayers(data: any): void;
    setSegment(init: number, end: number): void;
    resetSegments(forceFlag: boolean): void;
    hide(): void;
    show(): void;
    resize(width?: number, height?: number): void;
    setSpeed(speed: number): void;
    setDirection(direction: AnimationDirection): void;
    setLoop(isLooping: boolean): void;
    playSegments(segments: AnimationSegment | AnimationSegment[], forceFlag?: boolean): void;
    setSubframe(useSubFrames: boolean): void;
    getDuration(inFrames?: boolean): number;
    triggerEvent<T extends AnimationEventName>(name: T, args: AnimationEvents[T]): void;
    addEventListener<T extends AnimationEventName>(name: T, callback: AnimationEventCallback<AnimationEvents[T]>): () => void;
    removeEventListener<T extends AnimationEventName>(name: T, callback?: AnimationEventCallback<AnimationEvents[T]>): void;
}

/**
 * One step of a lookup: a step name and its argument. The player walks these itself, so
 * the sandbox names what it wants rather than holding anything. There are five steps.
 *
 * A path starts at `thisComp`; the first three re-root it.
 *
 * - `['comp', name]`      another composition, by name
 * - `['self', null]`      the property the expression belongs to
 * - `['layer', name]`     a layer of the current composition; a null argument means the
 *                         layer the expression belongs to
 * - `['prop', name]`      a property of whatever the path has reached. Own properties
 *                         only — an inherited read is refused, which is what keeps
 *                         `constructor`, and through it the global object, out of reach.
 *                         `maskPath` and `maskOpacity` are the two exceptions, being the
 *                         only accessors in the interface surface defined on a prototype.
 *                         If the target is callable and has no such own property it is
 *                         invoked with the name, which is how After Effects names most
 *                         things (`['prop', 'ADBE Transform Group']`).
 * - `['call', [name, …args]]`
 *                         invoke a method on whatever the path has reached, with plain
 *                         arguments. Invoked on that target, so a lookup such as
 *                         `toComp` applies to the layer the path named rather than to the
 *                         expression's own. Only these names are callable:
 *
 *                           layer, effect, content, mask, propertyGroup,
 *                           getValueAtTime, getVelocityAtTime, smooth,
 *                           loopIn, loopOut,
 *                           toComp, fromComp, toWorld, fromWorld,
 *                           points, inTangents, outTangents, isClosed,
 *                           pointOnPath, tangentOnPath,
 *                           nearestKey, key, wiggle
 *
 *                         The last three read the expression's own property and ignore
 *                         the walked target.
 *
 * Between the callable list and the own-property rule, the whole reachable surface is
 * two lists of names.
 */
export type ExpressionStep = [string, unknown];

export type ShapeDescriptor = {
    __shape: {
        /** Vertices, as [x, y] pairs. */
        v: number[][];
        /** In tangents, relative to their vertex. */
        i: number[][];
        /** Out tangents, relative to their vertex. */
        o: number[][];
        /** Whether the path is closed. */
        c: boolean;
    };
};

/** Host values for the frame being rendered. */
export type ExpressionBindings = {
    /** Seconds into the composition. */
    time: number;
    /** The property's own interpolated keyframe value for this frame. */
    value: unknown;
    index: number;
    /** Keyframes on this property; 0 when it is not animated. */
    numKeys: number;
    /** Text selector position; only meaningful on a text animator selector. */
    textIndex: number;
    textTotal: number;
    selectorValue: number;
    /**
     * Walks `path` and returns what it reaches, as a number, string, boolean, number
     * array, or array of number arrays. Throws if the path cannot be walked, or reaches
     * something that is not one of those — a live interface, an effect function or a
     * property group never crosses.
     */
    resolve(path: ExpressionStep[]): unknown;
};

export type CompiledExpression = {
    /**
     * Returns the value assigned to `$bm_rt`. Throwing drops the expression.
     * Return a ShapeDescriptor for a path-valued property; the player rebuilds it.
     */
    evaluate(bindings: ExpressionBindings): unknown;
};

/**
 * Evaluates expressions in place of `eval`, with no reference to any object in the player.
 * Supplied per `loadAnimation`, so every call site handling untrusted data must pass it.
 *
 * Two requirements are not visible in the source handed to an implementation: `evaluate`
 * must return the `$bm_rt` variable rather than the source's completion value, and the
 * implementation must turn expression syntax such as
 * `thisComp.layer(x).effect(y)(z)` into a `resolve` path itself — the player supplies the
 * walk and the value gate, and nothing else.
 *
 * A dropped expression keeps its baked keyframes, reports once, and is not retried. Note
 * that bodymovin wraps many expressions in their own try/catch: when a lookup the sandbox
 * cannot express is thrown inside one, the expression's own handler swallows it and the
 * property renders its baked value without `onExpressionDropped` ever firing. Drop counts
 * therefore understate divergence; compare rendered output to measure coverage.
 */
export type ExpressionSandbox = {
    compile(source: string): CompiledExpression;
    /** Must not throw; a throwing reporter is swallowed rather than failing the frame. */
    onExpressionDropped?(source: string, error: unknown): void;
};

export type BaseRendererConfig = {
    imagePreserveAspectRatio?: string;
    className?: string;
    /** Set false to ignore expressions entirely and use the baked keyframes. */
    runExpressions?: boolean;
    expressionSandbox?: ExpressionSandbox | null;
};

export type SVGRendererConfig = BaseRendererConfig & {
    title?: string;
    description?: string;
    preserveAspectRatio?: string;
    progressiveLoad?: boolean;
    hideOnTransparent?: boolean;
    viewBoxOnly?: boolean;
    viewBoxSize?: string;
    focusable?: boolean;
    filterSize?: FilterSizeConfig;
};

export type CanvasRendererConfig = BaseRendererConfig & {
    clearCanvas?: boolean;
    context?: CanvasRenderingContext2D;
    progressiveLoad?: boolean;
    preserveAspectRatio?: string;
    dpr?: number;
};

export type HTMLRendererConfig = BaseRendererConfig & {
    hideOnTransparent?: boolean;
};

export type RendererType = 'svg' | 'canvas' | 'html';

export type AnimationConfig<T extends RendererType = 'svg'> = {
    container: Element;
    renderer?: T;
    loop?: boolean | number;
    autoplay?: boolean;
    initialSegment?: AnimationSegment;
    name?: string;
    assetsPath?: string;
    rendererSettings?: {
        svg: SVGRendererConfig;
        canvas: CanvasRendererConfig;
        html: HTMLRendererConfig;
    }[T]
    audioFactory?(assetPath: string): {
        play(): void
        seek(): void
        playing(): void
        rate(): void
        setVolume(): void
    }
}

export type TextDocumentData = {
    t?: string;
    s?: number;
    f?: string;
    ca?: number;
    j?: number;
    tr?: number;
    lh?: number;
    ls?: number;
    fc?: [number, number, number];
}

export type AnimationConfigWithPath<T extends RendererType = 'svg'> = AnimationConfig<T> & {
    path?: string;
}

export type AnimationConfigWithData<T extends RendererType = 'svg'> = AnimationConfig<T> & {
    animationData?: any;
}

export type FilterSizeConfig = {
    width: string;
    height: string;
    x: string;
    y: string;
};

export type LottiePlayer = {
    play(name?: string): void;
    pause(name?: string): void;
    stop(name?: string): void;
    setSpeed(speed: number, name?: string): void;
    setDirection(direction: AnimationDirection, name?: string): void;
    searchAnimations(animationData?: any, standalone?: boolean, renderer?: string): void;
    loadAnimation<T extends RendererType = 'svg'>(params: AnimationConfigWithPath<T> | AnimationConfigWithData<T>): AnimationItem;
    destroy(name?: string): void;
    registerAnimation(element: Element, animationData?: any): void;
    setQuality(quality: string | number): void;
    setLocationHref(href: string): void;
    setIDPrefix(prefix: string): void;
    updateDocumentData(path: (string|number)[], documentData: TextDocumentData, index: number): void;
};

declare const Lottie: LottiePlayer;

export default Lottie;
