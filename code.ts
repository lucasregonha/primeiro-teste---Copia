"use strict";

// Exibe a UI do plugin
figma.showUI(__html__, { width: 360, height: 422 });


// Variáveis de estado
let showHiddenElements = false;
let currentTab: "colors" | "typography" = "colors";
let ignoringSelectionChange = false;
let rootFrameId: string | null = null;
let initialSelectionIds: string[] | null = null;
let nodesWithAppliedToken = new Set<string>();
// 🔥 CACHE GLOBAL
let cachedColorTokens: { name: string; hex: string; styleId?: string }[] | null = null;
let cachedTextTokens: { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[] | null = null;
let cachedPageId: string | null = null;

// 🔥 Armazena múltiplos frames selecionados
let rootFrameIds: string[] = [];


// 🔥 NOVO: Armazena o estado original dos nodes antes de aplicar tokens
interface OriginalNodeState {
    fillStyleId?: string | symbol;
    strokeStyleId?: string | symbol;
    textStyleId?: string | symbol;
    fills?: readonly Paint[];
    strokes?: readonly Paint[];
    // 🔥 Propriedades completas de texto
    fontName?: FontName | symbol;
    fontSize?: number | symbol;
    lineHeight?: LineHeight | symbol;
    letterSpacing?: LetterSpacing | symbol;
    textCase?: TextCase | symbol;
    textDecoration?: TextDecoration | symbol;
    paragraphSpacing?: number | symbol;
    paragraphIndent?: number | symbol;
}
let originalNodeStates = new Map<string, OriginalNodeState>();



/* ---------- HELPERS ---------- */

// Converte cor RGB para HEX
function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
    const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Type guard para SceneNode
function isSceneNode(node: BaseNode): node is SceneNode {
    return node.type !== "DOCUMENT" && node.type !== "PAGE";
}

// Type guard para Gradients
function isGradientPaint(p: Paint): p is GradientPaint {
    return (
        p.type === "GRADIENT_LINEAR" ||
        p.type === "GRADIENT_RADIAL" ||
        p.type === "GRADIENT_ANGULAR" ||
        p.type === "GRADIENT_DIAMOND"
    );
}

// Prefixos válidos de tokens de cor
const VALID_TOKEN_PREFIXES = [
    "Base Color/",
    "Contextual Color/",
    "Base/",
    "Surface Colors/",
    "Content Colors/",
    "Brand Colors/"
];

// Remove o prefixo do nome do token para exibição
function removeTokenPrefix(tokenName: string): string {
    let result = tokenName;

    // Remove emoji 📚 se existir
    result = result.replace(/^📚\s+/, '');

    // Remove todos os prefixos válidos
    for (const prefix of VALID_TOKEN_PREFIXES) {
        if (result.startsWith(prefix)) {
            result = result.substring(prefix.length);
        }
    }

    return result;
}

// 🔥 Verifica se um nome de token é válido para exibição (não é interno/privado)
function isValidTokenName(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.startsWith('_') || trimmed.startsWith('/')) return false;
    if (trimmed.length === 0) return false;
    return true;
}

// 🔥 Extrai o peso legível do fontStyle do Figma
function extractReadableWeight(fontStyle: string): string {
    const styleLower = fontStyle.toLowerCase();

    if (styleLower.includes("thin")) return "Thin";
    if (styleLower.includes("extralight") || styleLower.includes("extra light")) return "ExtraLight";
    if (styleLower.includes("light") && !styleLower.includes("extralight")) return "Light";
    if (styleLower.includes("medium")) return "Medium";
    if (styleLower.includes("semibold") || styleLower.includes("semi bold")) return "SemiBold";
    if (styleLower.includes("extrabold") || styleLower.includes("extra bold")) return "ExtraBold";
    if (styleLower.includes("bold") && !styleLower.includes("semibold") && !styleLower.includes("extrabold")) return "Bold";
    if (styleLower.includes("black") || styleLower.includes("heavy")) return "Black";
    if (styleLower.includes("regular") || styleLower.includes("normal")) return "Regular";

    return "Regular";
}

function calculateTextStyleDistance(
    source: { fontFamily: string; fontSize?: number; fontWeight?: any },
    target: { fontFamily?: string; fontSize?: number; fontWeight?: any }
): number {
    let distance = 0;

    if (source.fontFamily !== target.fontFamily) {
        distance += 100;
    }

    if (source.fontSize && target.fontSize) {
        distance += Math.abs(source.fontSize - target.fontSize);
    }

    const sourceWeight = typeof source.fontWeight === "number" ? source.fontWeight : 400;
    const targetWeight = typeof target.fontWeight === "number" ? target.fontWeight : 400;
    distance += Math.abs(sourceWeight - targetWeight) / 100;

    return distance;
}

// 🔥 CORRIGIDO: Verifica se um paint tem token válido
async function hasValidColorToken(node: SceneNode, paint: Paint, isStroke: boolean): Promise<boolean> {
    // 1️⃣ Variable
    if (paint.type === "SOLID") {
        if ("boundVariables" in paint && paint.boundVariables && "color" in paint.boundVariables) {
            return true;
        }
    }

    // 2️⃣ Fill Style (apenas se NÃO for stroke)
    if (!isStroke && !paint.type.startsWith("GRADIENT") && "fillStyleId" in node) {
        const styleId = node.fillStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    // 3️⃣ Stroke Style (apenas se for stroke)
    if (isStroke && !paint.type.startsWith("GRADIENT") && "strokeStyleId" in node) {
        const styleId = node.strokeStyleId;
        if (typeof styleId === "string" && styleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                if (style) {
                    return VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix));
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    return false;
}

// Verifica se um nó de texto tem token de tipografia válido
async function hasValidTextToken(node: TextNode): Promise<boolean> {
    if (node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
        return true;
    }
    return false;
}

// Coleta tokens de cor aplicados
async function collectAppliedColorTokens(
    frames: (FrameNode | ComponentNode | InstanceNode)[]
): Promise<{ name: string; hex: string; styleId?: string }[]> {

    if (cachedColorTokens && cachedPageId === figma.currentPage.id) {
        console.log("⚡ Usando cache de color tokens");
        return cachedColorTokens;
    }

    const tokenSet = new Map<string, { name: string; hex: string; styleId?: string }>();

    console.log("🔍 Coletando estilos de cor de TODO o arquivo...");

    const styleIdsInFile = new Set<string>();
    let nodesProcessed = 0;

    async function collectStyleIds(node: BaseNode) {
        if (!isSceneNode(node)) {
            if ("children" in node) {
                for (const child of node.children) {
                    await collectStyleIds(child);
                }
            }
            return;
        }

        nodesProcessed++;

        if ("fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId !== "") {
            styleIdsInFile.add(node.fillStyleId);
        }

        if ("strokeStyleId" in node && typeof node.strokeStyleId === "string" && node.strokeStyleId !== "") {
            styleIdsInFile.add(node.strokeStyleId);
        }

        if ("boundVariables" in node && node.boundVariables) {
            const bv = node.boundVariables as Record<string, any>;

            const fillVars = bv["fills"];
            if (Array.isArray(fillVars)) {
                for (const v of fillVars) {
                    if (v?.type === "VARIABLE_ALIAS" && v?.id) {
                        try {
                            const variable = await figma.variables.getVariableByIdAsync(v.id);
                            if (variable && variable.resolvedType === "COLOR") {
                                const varKey = `var_${variable.id}`;
                                const cleanName = removeTokenPrefix(variable.name);
                                if (!tokenSet.has(varKey) && isValidTokenName(cleanName)) {
                                    const fills = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
                                    const solidFill = fills.find((f: any) => f.type === "SOLID");
                                    const hex = solidFill ? rgbToHex(solidFill.color) : "#000000";
                                    tokenSet.set(varKey, { name: cleanName, hex, styleId: variable.id });
                                }
                            }
                        } catch (e) { }
                    }
                }
            }

            const strokeVars = bv["strokes"];
            if (Array.isArray(strokeVars)) {
                for (const v of strokeVars) {
                    if (v?.type === "VARIABLE_ALIAS" && v?.id) {
                        try {
                            const variable = await figma.variables.getVariableByIdAsync(v.id);
                            if (variable && variable.resolvedType === "COLOR") {
                                const varKey = `var_${variable.id}`;
                                const cleanName = removeTokenPrefix(variable.name);
                                if (!tokenSet.has(varKey) && isValidTokenName(cleanName)) {
                                    const strokes = "strokes" in node && Array.isArray(node.strokes) ? node.strokes : [];
                                    const solidStroke = strokes.find((s: any) => s.type === "SOLID");
                                    const hex = solidStroke ? rgbToHex(solidStroke.color) : "#000000";
                                    tokenSet.set(varKey, { name: cleanName, hex, styleId: variable.id });
                                }
                            }
                        } catch (e) { }
                    }
                }
            }
        }

        if ("children" in node) {
            for (const child of node.children) {
                await collectStyleIds(child);
            }
        }
    }

    await figma.currentPage.loadAsync();
    await collectStyleIds(figma.currentPage);

    console.log("   📊 Nodes processados:", nodesProcessed);
    console.log("   📌 Style IDs únicos:", styleIdsInFile.size);

    for (const styleId of styleIdsInFile) {
        try {
            const style = await figma.getStyleByIdAsync(styleId);
            if (style && style.type === "PAINT") {
                const paintStyle = style as PaintStyle;
                if (paintStyle.paints && paintStyle.paints.length > 0) {
                    const firstPaint = paintStyle.paints[0];
                    if (firstPaint.type === "SOLID") {
                        const hex = rgbToHex(firstPaint.color);
                        tokenSet.set(styleId, { name: removeTokenPrefix(paintStyle.name), hex, styleId });
                    }
                }
            }
        } catch (e) { }
    }

    const result = Array.from(tokenSet.values());
    cachedColorTokens = result;
    cachedPageId = figma.currentPage.id;
    return result;
}

// Coleta tokens de texto aplicados
async function collectAppliedTextTokens(
    frames: (FrameNode | ComponentNode | InstanceNode)[],
    currentStyle?: { fontFamily: string; fontSize?: number; fontWeight?: any }
): Promise<{ name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[]> {

    if (cachedTextTokens && cachedPageId === figma.currentPage.id) {
        console.log("⚡ Usando cache de text tokens");
        return cachedTextTokens;
    }

    const tokenSet = new Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>();
    const styleIdsInFile = new Set<string>();

    async function collectStyleIds(node: BaseNode) {
        if (!isSceneNode(node)) {
            if ("children" in node) {
                for (const child of node.children) {
                    await collectStyleIds(child);
                }
            }
            return;
        }

        if (node.type === "TEXT") {
            if (node.textStyleId && typeof node.textStyleId === "string" && node.textStyleId !== "") {
                styleIdsInFile.add(node.textStyleId);
            }
        }

        if ("children" in node) {
            for (const child of node.children) {
                await collectStyleIds(child);
            }
        }
    }

    await collectStyleIds(figma.currentPage);

    if (styleIdsInFile.size === 0) {
        const localStyles = await figma.getLocalTextStylesAsync();
        for (const style of localStyles) {
            styleIdsInFile.add(style.id);
        }
    }

    for (const styleId of styleIdsInFile) {
        try {
            const style = await figma.getStyleByIdAsync(styleId);
            if (style && style.type === "TEXT") {
                const textStyle = style as TextStyle;
                if (textStyle.fontName && typeof textStyle.fontName === 'object' && 'family' in textStyle.fontName) {
                    try {
                        await figma.loadFontAsync(textStyle.fontName as FontName);
                        const key = `${textStyle.name}_${styleId}`;
                        tokenSet.set(key, {
                            name: textStyle.name,
                            styleId,
                            fontFamily: textStyle.fontName.family,
                            fontStyle: textStyle.fontName.style,
                            fontSize: typeof textStyle.fontSize === 'number' ? textStyle.fontSize : undefined
                        });
                    } catch (fontError) { }
                }
            }
        } catch (e) { }
    }

    let tokens = Array.from(tokenSet.values());

    if (currentStyle) {
        tokens = tokens.sort((a, b) => {
            const distA = calculateTextStyleDistance(currentStyle, a);
            const distB = calculateTextStyleDistance(currentStyle, b);
            return distA - distB;
        });
    }

    cachedTextTokens = tokens;
    cachedPageId = figma.currentPage.id;
    return tokens;
}

/* ---------- ANALYZE FUNCTIONS ---------- */

async function analyzeColors(
    nodes: (FrameNode | ComponentNode | InstanceNode | SectionNode)[]
) {
    const map = new Map<
        string,
        { nodeId: string; node: SceneNode; paint: Paint; isStroke: boolean; label: string; name: string }[]
    >();

    async function processPaint(node: SceneNode, paint: Paint, isStroke: boolean): Promise<void> {
        if (!paint || paint.visible === false) return;
        if (paint.type === "IMAGE" || paint.type === "VIDEO" || paint.type === "PATTERN") return;

        const hasToken = await hasValidColorToken(node, paint, isStroke);
        if (hasToken) return;

        let label: string;
        let name: string;

        if (paint.type === "SOLID") {
            label = rgbToHex(paint.color);
        } else if (isGradientPaint(paint)) {
            label = "Gradiente";
        } else {
            return;
        }

        let styleId: string | undefined;
        if ("fillStyleId" in node && !isStroke) {
            styleId = node.fillStyleId as string | undefined;
        } else if ("strokeStyleId" in node && isStroke) {
            styleId = node.strokeStyleId as string | undefined;
        }

        if (styleId) {
            try {
                const style = await figma.getStyleByIdAsync(styleId);
                name = style ? style.name : label;
            } catch (e) {
                name = label;
            }
        } else {
            name = label;
        }

        const key = `${label}_${isStroke ? "stroke" : "fill"}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, paint, isStroke, label, name });
    }

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        if ("fills" in node && Array.isArray(node.fills)) {
            for (const p of node.fills) {
                await processPaint(node, p, false);
            }
        }

        if ("strokes" in node && Array.isArray(node.strokes)) {
            for (const p of node.strokes) {
                await processPaint(node, p, true);
            }
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    // 🔥 CORRIGIDO: Percorre TODOS os frames passados
    for (const node of nodes) {
        await walk(node);
    }

    const groups = Array.from(map.values()).map(nodePaints => ({
        label: nodePaints[0].label,
        nodePaints
    }));

    figma.ui.postMessage({ type: "result-colors", groups });
}

async function analyzeTypography(
    nodes: (FrameNode | ComponentNode | InstanceNode | SectionNode)[]
) {
    const map = new Map<string, { nodeId: string; node: TextNode; style: CustomTextStyle }[]>();

    async function processTextNode(node: TextNode): Promise<void> {
        const hasToken = await hasValidTextToken(node);
        if (hasToken) return;

        const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Mixed", style: "Mixed" };
        const fontSize = node.fontSize !== figma.mixed ? node.fontSize : "Mixed";
        const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : "Mixed";
        const lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "AUTO";
        const letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "0";

        const readableWeight = extractReadableWeight(fontName.style);

        const style: CustomTextStyle = {
            fontFamily: fontName.family,
            fontStyle: fontName.style,
            readableWeight: readableWeight,
            fontSize: fontSize,
            fontWeight: fontWeight,
            lineHeight: lineHeight,
            letterSpacing: letterSpacing
        };

        const key = `${fontName.family}_${fontName.style}`;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, style });
    }

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        if (node.type === "TEXT") {
            await processTextNode(node);
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    // 🔥 CORRIGIDO: Percorre TODOS os frames passados
    for (const node of nodes) {
        await walk(node);
    }

    const groups = Array.from(map.values()).map(nodeStyles => {
        const first = nodeStyles[0].style;
        return {
            style: first,
            nodeStyles,
            label: `${first.fontFamily} ${first.readableWeight}`
        };
    });

    figma.ui.postMessage({ type: "result-typography", groups });
}

/* ---------- TYPES ---------- */

interface CustomTextStyle {
    fontFamily: string;
    fontStyle: string;
    readableWeight?: string;
    fontSize: any;
    fontWeight: any;
    lineHeight: any;
    letterSpacing: any;
}

/* ---------- HELPERS ---------- */

// 🔥 NOVO: Coleta todos os frames válidos da seleção atual
function getValidFramesFromSelection(): (FrameNode | ComponentNode | InstanceNode | SectionNode)[] {
    const selection = figma.currentPage.selection;
    const frames: (FrameNode | ComponentNode | InstanceNode | SectionNode)[] = [];

    for (const node of selection) {
        let current: SceneNode | null = node;

        // Sobe até encontrar um container válido
        while (
            current &&
            current.type !== "FRAME" &&
            current.type !== "COMPONENT" &&
            current.type !== "INSTANCE" &&
            current.type !== "SECTION"
        ) {
            current = current.parent as SceneNode;
        }

        if (current && !frames.some(f => f.id === current!.id)) {
            frames.push(current as FrameNode | ComponentNode | InstanceNode | SectionNode);
        }
    }

    return frames;
}

/* ---------- EVENTS ---------- */

figma.on("selectionchange", async () => {
    console.log("SELECTION CHANGED");

    if (ignoringSelectionChange) {
        console.log("IGNORE CHANGED");
        return;
    }

    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
        // 🔥 Limpa os IDs salvos para que switch-tab não use frames antigos
        rootFrameIds = [];
        rootFrameId = null;
        figma.ui.postMessage({ type: "empty", clearAll: true });
        return;
    }

    // 🔥 CORRIGIDO: Coleta TODOS os frames únicos da seleção
    const containers = getValidFramesFromSelection();

    if (containers.length === 0) return;

    // 🔥 Atualiza lista de IDs raiz
    const newFrameIds = containers.map(c => c.id);
    const frameChanged = JSON.stringify(newFrameIds) !== JSON.stringify(rootFrameIds);

    rootFrameIds = newFrameIds;
    rootFrameId = newFrameIds[0]; // mantém compatibilidade

    figma.ui.postMessage({ type: "selection-changed" });

    if (frameChanged) {
        figma.ui.postMessage({ type: "frame-changed" });
    }

    if (currentTab === "colors") {
        await analyzeColors(containers);
    } else {
        await analyzeTypography(containers);
    }
});


figma.ui.onmessage = async (msg) => {
    console.log("📩 mensagem recebida:", msg);

    // 🔙 Voltar para lista
    if (msg.type === "back-to-list") {
        console.log("🔙 Voltando para lista...");

        if (initialSelectionIds && initialSelectionIds.length > 0) {
            console.log("📌 Restaurando seleção:", initialSelectionIds);

            const nodes: SceneNode[] = [];
            for (const id of initialSelectionIds) {
                const node = await figma.getNodeByIdAsync(id);
                if (node && isSceneNode(node)) {
                    nodes.push(node);
                }
            }

            if (nodes.length > 0) {
                // 🔥 CORRIGIDO: Seta o flag ANTES de mudar a seleção
                ignoringSelectionChange = true;

                figma.currentPage.selection = nodes;
                figma.viewport.scrollAndZoomIntoView(nodes);

                console.log("✅ Seleção restaurada:", nodes.map(n => n.name));

                // 🔥 CORRIGIDO: Desativa o flag com delay suficiente
                await new Promise(resolve => setTimeout(resolve, 100));
                ignoringSelectionChange = false;

                // Re-analisa com todos os frames
                const validNodes = nodes.filter(
                    (n): n is FrameNode | ComponentNode | InstanceNode =>
                        n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
                );

                // 🔥 CORRIGIDO: Se seleção original não tem frames diretos, usa rootFrameIds
                if (validNodes.length > 0) {
                    console.log("🔄 Re-analisando frames...");
                    if (currentTab === "colors") {
                        await analyzeColors(validNodes);
                    } else {
                        await analyzeTypography(validNodes);
                    }
                } else if (rootFrameIds.length > 0) {
                    const rootNodes: (FrameNode | ComponentNode | InstanceNode)[] = [];
                    for (const id of rootFrameIds) {
                        const n = await figma.getNodeByIdAsync(id);
                        if (n && (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE")) {
                            rootNodes.push(n as FrameNode | ComponentNode | InstanceNode);
                        }
                    }
                    if (rootNodes.length > 0) {
                        if (currentTab === "colors") {
                            await analyzeColors(rootNodes);
                        } else {
                            await analyzeTypography(rootNodes);
                        }
                    }
                }
            }
        }

        initialSelectionIds = null;
        nodesWithAppliedToken.clear();
        originalNodeStates.clear();

        return;
    }

    // 🔒 Salvar seleção inicial
    if (msg.type === "save-initial-selection") {
        if (!initialSelectionIds) {
            initialSelectionIds = figma.currentPage.selection.map(n => n.id);
            console.log("📌 Seleção inicial salva (save):", initialSelectionIds);
        }
        return;
    }

    // 🔥 Salvar estado original dos nodes
    if (msg.type === "save-original-state") {
        const nodeIds: string[] = msg.nodeIds || [];
        console.log("📌 Salvando estado original de", nodeIds.length, "nodes");

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node) continue;

            const state: OriginalNodeState = {};

            if (isSceneNode(node)) {
                if ("fillStyleId" in node) state.fillStyleId = node.fillStyleId;
                if ("strokeStyleId" in node) state.strokeStyleId = node.strokeStyleId;
                if ("fills" in node) state.fills = JSON.parse(JSON.stringify(node.fills));
                if ("strokes" in node) state.strokes = JSON.parse(JSON.stringify(node.strokes));
            }

            if (node.type === "TEXT") {
                try {
                    if (node.fontName !== figma.mixed) {
                        await figma.loadFontAsync(node.fontName as FontName);
                    }
                    state.textStyleId = node.textStyleId;
                    state.fontName = node.fontName;
                    state.fontSize = node.fontSize;
                    state.lineHeight = node.lineHeight;
                    state.letterSpacing = node.letterSpacing;
                    state.textCase = node.textCase;
                    state.textDecoration = node.textDecoration;
                    state.paragraphSpacing = node.paragraphSpacing;
                    state.paragraphIndent = node.paragraphIndent;
                } catch (e) {
                    console.error("❌ Erro ao salvar estado de texto:", e);
                }
            }

            originalNodeStates.set(nodeId, state);
        }
        return;
    }

    if (msg.type === "enter-list-view") {
        initialSelectionIds = figma.currentPage.selection.map(n => n.id);
        console.log("📌 seleção inicial atualizada:", initialSelectionIds);

        // 🔥 CORRIGIDO: Salva TODOS os frames válidos
        const containers = getValidFramesFromSelection();
        if (containers.length > 0) {
            rootFrameIds = containers.map(c => c.id);
            rootFrameId = rootFrameIds[0];
            console.log("📌 rootFrameIds atualizados:", rootFrameIds);
        }
    }

    if (msg.type === "select-node") {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId);
            if (node && isSceneNode(node)) {
                // 🔥 CORRIGIDO: Seta flag ANTES, desativa com promise
                ignoringSelectionChange = true;
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
                await new Promise(resolve => setTimeout(resolve, 50));
                ignoringSelectionChange = false;
            }
        } catch (err) {
            console.error("Erro ao buscar node:", err);
            ignoringSelectionChange = false;
        }
    }

    if (msg.type === "select-multiple-nodes") {
        try {
            // 🔥 CORRIGIDO: Seta flag ANTES, desativa com promise
            ignoringSelectionChange = true;

            const nodes = await Promise.all(
                msg.nodeIds.map((id: string) => figma.getNodeByIdAsync(id))
            );

            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

            const safeNodes = validNodes.filter(n => {
                if (n.type === "TEXT") return n.characters.length > 0;
                return true;
            });

            if (safeNodes.length) {
                figma.currentPage.selection = safeNodes;
                figma.viewport.scrollAndZoomIntoView(safeNodes);
            }

            await new Promise(resolve => setTimeout(resolve, 50));
            ignoringSelectionChange = false;
        } catch (err) {
            console.error("Erro ao selecionar nodes:", err);
            ignoringSelectionChange = false;
        }
    }

    if (msg.type === "get-suggested-tokens") {
        try {
            // 🔥 CORRIGIDO: Usa rootFrameIds para buscar todos os frames
            let validNodes: (FrameNode | ComponentNode | InstanceNode)[] = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode =>
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );

            if (validNodes.length === 0 && rootFrameIds.length > 0) {
                for (const id of rootFrameIds) {
                    const rootNode = await figma.getNodeByIdAsync(id);
                    if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                        validNodes.push(rootNode as FrameNode | ComponentNode | InstanceNode);
                    }
                }
            }

            if (validNodes.length > 0) {
                if (currentTab === "colors") {
                    const appliedTokens = await collectAppliedColorTokens(validNodes);
                    figma.ui.postMessage({ type: "result-suggested-tokens", tokens: appliedTokens });
                } else {
                    let currentStyle = undefined;
                    if (msg.nodeId) {
                        const node = await figma.getNodeByIdAsync(msg.nodeId);
                        if (node && node.type === "TEXT" && node.characters.length > 0) {
                            const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" };
                            const fontSize = node.fontSize !== figma.mixed ? node.fontSize : 14;
                            const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : 400;
                            currentStyle = { fontFamily: fontName.family, fontSize, fontWeight };
                        }
                    }
                    const appliedTokens = await collectAppliedTextTokens(validNodes, currentStyle);
                    figma.ui.postMessage({ type: "result-suggested-text-tokens", tokens: appliedTokens });
                }
            } else {
                figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
            }
        } catch (err) {
            console.error("Erro ao buscar tokens sugeridos:", err);
            figma.ui.postMessage({ type: "result-suggested-tokens", tokens: [] });
        }
    }

    if (msg.type === "apply-token-multiple") {
        const styleId = msg.styleId;
        const nodeIds: string[] = msg.nodeIds || [];
        const isStroke = msg.isStroke || false;
        let lastDisplayName = styleId;

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || !isSceneNode(node)) continue;

            const variable = await figma.variables.getVariableByIdAsync(styleId).catch(() => null);

            if (variable && variable.resolvedType === "COLOR") {
                if (!isStroke && "fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
                    const newFills = node.fills.map((fill: Paint, i: number) =>
                        i === 0 ? figma.variables.setBoundVariableForPaint(fill as SolidPaint, "color", variable) : fill
                    );
                    node.fills = newFills;
                } else if (isStroke && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
                    const newStrokes = node.strokes.map((stroke: Paint, i: number) =>
                        i === 0 ? figma.variables.setBoundVariableForPaint(stroke as SolidPaint, "color", variable) : stroke
                    );
                    node.strokes = newStrokes;
                }
                lastDisplayName = removeTokenPrefix(variable.name);
                figma.ui.postMessage({ type: "update-detail", nodeId: node.id, styleName: lastDisplayName, styleId: variable.id });
            } else {
                const style = await figma.getStyleByIdAsync(styleId);
                if (!style || style.type !== "PAINT") continue;

                if (isStroke && "setStrokeStyleIdAsync" in node) {
                    await node.setStrokeStyleIdAsync(styleId);
                } else if (!isStroke && "setFillStyleIdAsync" in node) {
                    await node.setFillStyleIdAsync(styleId);
                }

                lastDisplayName = removeTokenPrefix(style.name);
                figma.ui.postMessage({ type: "update-detail", nodeId: node.id, styleName: lastDisplayName, styleId: style.id });
            }
        }

        figma.ui.postMessage({ type: "token-applied-success", styleName: lastDisplayName, styleId });
    }

    if (msg.type === "apply-token") {
        try {
            const styleId = msg.styleId;
            const isStroke = msg.isStroke;
            const isText = msg.isText || false;
            const nodeIds: string[] = msg.nodeIds || [msg.nodeId];
            const nodes = await Promise.all(nodeIds.map(id => figma.getNodeByIdAsync(id)));
            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));

            const variable = !isText ? await figma.variables.getVariableByIdAsync(styleId).catch(() => null) : null;

            await Promise.all(validNodes.map(async (node) => {
                if (isText && node.type === "TEXT") {
                    const style = await figma.getStyleByIdAsync(styleId);
                    if (style && style.type === "TEXT") {
                        await figma.loadFontAsync(style.fontName as FontName);
                        await node.setTextStyleIdAsync(styleId);
                    }
                } else if (variable && variable.resolvedType === "COLOR") {
                    if (!isStroke && "fills" in node && Array.isArray(node.fills) && node.fills.length > 0) {
                        const newFills = node.fills.map((fill: Paint, i: number) =>
                            i === 0 ? figma.variables.setBoundVariableForPaint(fill as SolidPaint, "color", variable) : fill
                        );
                        node.fills = newFills;
                    } else if (isStroke && "strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
                        const newStrokes = node.strokes.map((stroke: Paint, i: number) =>
                            i === 0 ? figma.variables.setBoundVariableForPaint(stroke as SolidPaint, "color", variable) : stroke
                        );
                        node.strokes = newStrokes;
                    }
                } else {
                    if (isStroke && "setStrokeStyleIdAsync" in node) {
                        await node.setStrokeStyleIdAsync(styleId);
                    } else if (!isStroke && "setFillStyleIdAsync" in node) {
                        await node.setFillStyleIdAsync(styleId);
                    }
                }

                const rawName = variable ? variable.name : (await figma.getStyleByIdAsync(styleId))?.name || styleId;
                const displayName = removeTokenPrefix(rawName);
                figma.ui.postMessage({ type: "update-detail", nodeId: node.id, styleName: displayName, styleId });
            }));

            const rawName = variable ? variable.name : (await figma.getStyleByIdAsync(styleId))?.name || styleId;
            figma.ui.postMessage({ type: "token-applied-success", styleName: removeTokenPrefix(rawName), styleId });

        } catch (err) {
            console.error("Erro ao aplicar token:", err);
            figma.ui.postMessage({ type: "token-applied-error" });
        }
    }

    if (msg.type === "apply-typography-token-multiple") {
        console.log("📩 apply-typography-token-multiple recebido:", msg);

        const styleId = msg.styleId;
        const nodeIds: string[] = msg.nodeIds || [];

        const style = await figma.getStyleByIdAsync(styleId);

        if (!style || style.type !== "TEXT") {
            figma.ui.postMessage({ type: "token-applied-error" });
            return;
        }

        let successCount = 0;
        let errorNodes: string[] = [];

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);

            if (node && node.type === "TEXT") {
                try {
                    await figma.loadFontAsync(style.fontName as FontName);
                    await node.setTextStyleIdAsync(styleId);
                    successCount++;
                    figma.ui.postMessage({ type: "update-detail", nodeId: node.id, styleName: style.name, styleId: style.id });
                } catch (fontError) {
                    errorNodes.push(node.name);
                    try {
                        const currentFont = node.fontName !== figma.mixed ? node.fontName : { family: "Inter", style: "Regular" };
                        await figma.loadFontAsync(currentFont as FontName);
                        await node.setTextStyleIdAsync(styleId);
                        successCount++;
                    } catch (fallbackError) {
                        console.error("❌ Erro mesmo com fallback:", fallbackError);
                    }
                }
            }
        }

        if (successCount > 0) {
            let successMessage = style.name;
            if (errorNodes.length > 0) {
                successMessage += ` (Fonte não disponível em ${errorNodes.length} elemento(s))`;
            }
            figma.ui.postMessage({ type: "token-applied-success", styleName: successMessage, styleId: style.id });
        } else {
            figma.ui.postMessage({ type: "token-applied-error", message: "Não foi possível aplicar o estilo." });
        }
    }

    if (msg.type === "toggle-hidden") {
        showHiddenElements = msg.value;

        // 🔥 CORRIGIDO: Usa rootFrameIds
        let validNodes: (FrameNode | ComponentNode | InstanceNode)[] = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        if (validNodes.length === 0 && rootFrameIds.length > 0) {
            for (const id of rootFrameIds) {
                const rootNode = await figma.getNodeByIdAsync(id);
                if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                    validNodes.push(rootNode as FrameNode | ComponentNode | InstanceNode);
                }
            }
        }

        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                await analyzeColors(validNodes);
            } else {
                await analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "switch-tab") {
        currentTab = msg.tab;

        // 🔥 CORRIGIDO: Só usa rootFrameIds se ainda há seleção ativa no canvas
        const hasActiveSelection = figma.currentPage.selection.length > 0;

        let validNodes: (FrameNode | ComponentNode | InstanceNode)[] = [];

        if (hasActiveSelection) {
            // Tem seleção: coleta os frames dela
            validNodes = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode =>
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );

            // Se selecionou filhos (não frames diretos), sobe para os containers
            if (validNodes.length === 0) {
                const containers = getValidFramesFromSelection();
                validNodes = containers.filter(
                    (n): n is FrameNode | ComponentNode | InstanceNode =>
                        n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
                );
            }

            // Fallback: usa rootFrameIds mas só porque ainda há seleção
            if (validNodes.length === 0 && rootFrameIds.length > 0) {
                for (const id of rootFrameIds) {
                    const rootNode = await figma.getNodeByIdAsync(id);
                    if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                        validNodes.push(rootNode as FrameNode | ComponentNode | InstanceNode);
                    }
                }
            }
        }

        if (validNodes.length === 0) {
            figma.ui.postMessage({ type: "empty", clearAll: true });
        } else {
            if (currentTab === "colors") {
                analyzeColors(validNodes);
            } else {
                analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "remove-color-token") {
        console.log("📩 remove-color-token recebido:", msg);
        const nodeIds: string[] = msg.nodeIds || [];
        const isStroke = msg.isStroke || false;

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || !isSceneNode(node)) continue;

            try {
                const originalState = originalNodeStates.get(nodeId);

                if (originalState) {
                    if (isStroke) {
                        if (originalState.strokeStyleId !== undefined && "setStrokeStyleIdAsync" in node) {
                            if (typeof originalState.strokeStyleId === 'string') {
                                await node.setStrokeStyleIdAsync(originalState.strokeStyleId);
                            } else if (originalState.strokeStyleId === figma.mixed) {
                                await node.setStrokeStyleIdAsync("");
                            }
                        }
                        if (originalState.strokes !== undefined && "strokes" in node) {
                            node.strokes = originalState.strokes as Paint[];
                        }
                    } else {
                        if (originalState.fillStyleId !== undefined && "setFillStyleIdAsync" in node) {
                            if (typeof originalState.fillStyleId === 'string') {
                                await node.setFillStyleIdAsync(originalState.fillStyleId);
                            } else if (originalState.fillStyleId === figma.mixed) {
                                await node.setFillStyleIdAsync("");
                            }
                        }
                        if (originalState.fills !== undefined && "fills" in node) {
                            node.fills = originalState.fills as Paint[];
                        }
                    }
                } else {
                    if (isStroke && "setStrokeStyleIdAsync" in node) {
                        await node.setStrokeStyleIdAsync("");
                    } else if (!isStroke && "setFillStyleIdAsync" in node) {
                        await node.setFillStyleIdAsync("");
                    }
                }
            } catch (e) {
                console.error("❌ Erro ao remover token de cor:", e);
            }
        }

        figma.ui.postMessage({ type: "token-removed-success" });
    }

    if (msg.type === "remove-text-token") {
        console.log("📩 remove-text-token recebido:", msg);
        const nodeIds: string[] = msg.nodeIds || [];

        for (const nodeId of nodeIds) {
            const node = await figma.getNodeByIdAsync(nodeId);

            if (node && node.type === "TEXT") {
                try {
                    if (!node.textStyleId || node.textStyleId === "") continue;

                    const originalState = originalNodeStates.get(nodeId);

                    if (originalState && originalState.fontName && originalState.fontName !== figma.mixed) {
                        await figma.loadFontAsync(originalState.fontName as FontName);
                        await node.setTextStyleIdAsync("");
                        node.fontName = originalState.fontName as FontName;

                        if (originalState.fontSize !== undefined && typeof originalState.fontSize === 'number') {
                            node.fontSize = originalState.fontSize;
                        }
                        if (originalState.lineHeight !== undefined && originalState.lineHeight !== figma.mixed) {
                            node.lineHeight = originalState.lineHeight as LineHeight;
                        }
                        if (originalState.letterSpacing !== undefined && originalState.letterSpacing !== figma.mixed) {
                            node.letterSpacing = originalState.letterSpacing as LetterSpacing;
                        }
                        if (originalState.textCase !== undefined && originalState.textCase !== figma.mixed) {
                            node.textCase = originalState.textCase as TextCase;
                        }
                        if (originalState.textDecoration !== undefined && originalState.textDecoration !== figma.mixed) {
                            node.textDecoration = originalState.textDecoration as TextDecoration;
                        }
                        if (originalState.paragraphSpacing !== undefined && typeof originalState.paragraphSpacing === 'number') {
                            node.paragraphSpacing = originalState.paragraphSpacing;
                        }
                        if (originalState.paragraphIndent !== undefined && typeof originalState.paragraphIndent === 'number') {
                            node.paragraphIndent = originalState.paragraphIndent;
                        }
                    } else if (originalState && originalState.textStyleId !== undefined && typeof originalState.textStyleId === 'string') {
                        if (originalState.textStyleId !== "") {
                            try {
                                const originalStyle = await figma.getStyleByIdAsync(originalState.textStyleId);
                                if (originalStyle && originalStyle.type === "TEXT") {
                                    await figma.loadFontAsync(originalStyle.fontName as FontName);
                                    await node.setTextStyleIdAsync(originalState.textStyleId);
                                }
                            } catch (e) {
                                if (node.fontName !== figma.mixed) {
                                    await figma.loadFontAsync(node.fontName as FontName);
                                }
                                await node.setTextStyleIdAsync("");
                            }
                        } else {
                            if (node.fontName !== figma.mixed) {
                                await figma.loadFontAsync(node.fontName as FontName);
                            }
                            await node.setTextStyleIdAsync("");
                        }
                    } else {
                        if (node.fontName !== figma.mixed) {
                            await figma.loadFontAsync(node.fontName as FontName);
                        }
                        await node.setTextStyleIdAsync("");
                    }
                } catch (e) {
                    console.error("❌ Erro ao remover estilo:", e);
                }
            }
        }

        figma.ui.postMessage({ type: "token-removed-success" });
    }

    if (msg.type === "reanalyze") {
        // 🔥 CORRIGIDO: Usa rootFrameIds
        let validNodes: (FrameNode | ComponentNode | InstanceNode)[] = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode =>
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );

        if (validNodes.length === 0 && rootFrameIds.length > 0) {
            for (const id of rootFrameIds) {
                const rootNode = await figma.getNodeByIdAsync(id);
                if (rootNode && (rootNode.type === "FRAME" || rootNode.type === "COMPONENT" || rootNode.type === "INSTANCE")) {
                    validNodes.push(rootNode as FrameNode | ComponentNode | InstanceNode);
                }
            }
        }

        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                await analyzeColors(validNodes);
            } else {
                await analyzeTypography(validNodes);
            }
        }
    }
};

/* ---------- INIT ---------- */
figma.ui.postMessage({ type: "init-tab", tab: currentTab });

(async () => {
    // 🔥 CORRIGIDO: Coleta todos os frames válidos da seleção inicial
    const containers = getValidFramesFromSelection();

    if (containers.length > 0) {
        rootFrameIds = containers.map(c => c.id);
        rootFrameId = rootFrameIds[0];
        initialSelectionIds = figma.currentPage.selection.map(n => n.id);
        console.log("✅ Frames ao iniciar:", containers.map(c => c.name));

        if (currentTab === "colors") {
            analyzeColors(containers);
        } else {
            analyzeTypography(containers);
        }
    } else {
        figma.ui.postMessage({ type: "empty", clearAll: true });
    }
})();

console.log("Plugin iniciado ✅");