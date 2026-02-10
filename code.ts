"use strict";

// Exibe a UI do plugin
figma.showUI(__html__, { width: 360, height: 422 });

// Variáveis de estado
let showHiddenElements = false;
let currentTab: "colors" | "typography" = "colors";
let ignoringSelectionChange = false;

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

// Verifica se um paint tem token válido
async function hasValidColorToken(node: SceneNode, paint: Paint): Promise<boolean> {
    // 1️⃣ Variable
    if (paint.type === "SOLID") {
        if ("boundVariables" in paint && paint.boundVariables && "color" in paint.boundVariables) {
            return true;
        }
    }

    // 2️⃣ Fill Style
    if (!paint.type.startsWith("GRADIENT") && "fillStyleId" in node) {
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

    // 3️⃣ Stroke Style
    if (!paint.type.startsWith("GRADIENT") && "strokeStyleId" in node) {
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

// Função helper para fazer yield e permitir UI updates
function yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

// Percorre nó recursivamente coletando tokens de COR
async function walkForColorTokens(node: SceneNode, tokenSet: Map<string, { name: string; hex: string; styleId?: string }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa fills
    if ("fills" in node && Array.isArray(node.fills)) {
        for (const p of node.fills) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "fillStyleId" in node) {
                const styleId = node.fillStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Processa strokes
    if ("strokes" in node && Array.isArray(node.strokes)) {
        for (const p of node.strokes) {
            if (!p || p.visible === false || p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") continue;

            if (p.type === "SOLID" && "strokeStyleId" in node) {
                const styleId = node.strokeStyleId;
                if (typeof styleId === "string" && styleId !== "") {
                    try {
                        const style = await figma.getStyleByIdAsync(styleId);
                        if (style && VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
                            const hex = rgbToHex(p.color);
                            const key = `${style.name}_${hex}`;
                            tokenSet.set(key, { name: style.name, hex, styleId });
                        }
                    } catch (e) {
                        // Style não encontrado
                    }
                }
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForColorTokens(c, tokenSet);
        }
    }
}

// Percorre nó recursivamente coletando tokens de TIPOGRAFIA
async function walkForTextTokens(node: SceneNode, tokenSet: Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>): Promise<void> {
    if (!showHiddenElements && !node.visible) return;

    // Processa texto
    if (node.type === "TEXT") {
        const textNode = node as TextNode;
        if (textNode.textStyleId && typeof textNode.textStyleId === "string" && textNode.textStyleId !== "") {
            try {
                const style = await figma.getStyleByIdAsync(textNode.textStyleId);
                if (style && style.type === "TEXT") {
                    const key = style.id;
                    
                    // Extrai informações do estilo
                    const fontName = textNode.fontName !== figma.mixed ? textNode.fontName : { family: "Mixed", style: "Mixed" };
                    const fontSize = textNode.fontSize !== figma.mixed ? textNode.fontSize : undefined;
                    
                    tokenSet.set(key, { 
                        name: style.name, 
                        styleId: style.id,
                        fontFamily: fontName.family,
                        fontStyle: fontName.style,
                        fontSize: fontSize
                    });
                }
            } catch (e) {
                // Style não encontrado
            }
        }
    }

    // Percorre filhos recursivamente
    if ("children" in node) {
        for (const c of node.children) {
            if (isSceneNode(c)) await walkForTextTokens(c, tokenSet);
        }
    }
}

// Coleta tokens de cor aplicados - busca em TODA a página E estilos locais
async function collectAppliedColorTokens(frames: (FrameNode | ComponentNode | InstanceNode)[]): Promise<{ name: string; hex: string; styleId?: string }[]> {
    const tokenSet = new Map<string, { name: string; hex: string; styleId?: string }>();

    // 🔥 PRIMEIRO: Busca todos os estilos locais disponíveis no documento
    const localStyles = await figma.getLocalPaintStylesAsync();
    for (const style of localStyles) {
        // Verifica se tem prefixo válido
        if (VALID_TOKEN_PREFIXES.some(prefix => style.name.startsWith(prefix))) {
            // Verifica se é um estilo SOLID
            if (style.paints && style.paints.length > 0) {
                const firstPaint = style.paints[0];
                if (firstPaint.type === "SOLID") {
                    const hex = rgbToHex(firstPaint.color);
                    const key = `${style.name}_${hex}`;
                    tokenSet.set(key, { name: style.name, hex, styleId: style.id });
                }
            }
        }
    }

    // 1️⃣ Nível 1: Frame selecionado e seus filhos
    for (const frame of frames) {
        await walkForColorTokens(frame, tokenSet);
    }

    // 2️⃣ Nível 2: Todos os pais do frame até a raiz
    const parentsAnalyzed = new Set<string>();
    for (const frame of frames) {
        let current: BaseNode | null = frame.parent;
        while (current && current.type !== "PAGE") {
            if (!parentsAnalyzed.has(current.id)) {
                if (isSceneNode(current)) {
                    await walkForColorTokens(current, tokenSet);
                }
                parentsAnalyzed.add(current.id);
            }
            current = current.parent;
        }
    }

    // 3️⃣ Nível 3: Todos os irmãos em cada nível da hierarquia
    const siblingsAnalyzed = new Set<string>();
    for (const frame of frames) {
        let current: BaseNode | null = frame;
        while (current && current.type !== "PAGE") {
            if (current.parent && "children" in current.parent) {
                for (const sibling of current.parent.children) {
                    if (isSceneNode(sibling) && !siblingsAnalyzed.has(sibling.id)) {
                        await walkForColorTokens(sibling, tokenSet);
                        siblingsAnalyzed.add(sibling.id);
                    }
                }
            }
            current = current.parent;
        }
    }

    // 4️⃣ Nível 4: Busca na página inteira como fallback
    const pageChildren = figma.currentPage.children;
    for (const child of pageChildren) {
        if (isSceneNode(child) && !siblingsAnalyzed.has(child.id)) {
            await walkForColorTokens(child, tokenSet);
        }
    }

    return Array.from(tokenSet.values());
}

// Coleta tokens de tipografia aplicados - busca em TODA a página E estilos locais
async function collectAppliedTextTokens(frames: (FrameNode | ComponentNode | InstanceNode)[]): Promise<{ name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }[]> {
    const tokenSet = new Map<string, { name: string; styleId: string; fontFamily?: string; fontStyle?: string; fontSize?: number }>();

    // 🔥 PRIMEIRO: Busca todos os estilos de texto locais disponíveis no documento
    const localStyles = await figma.getLocalTextStylesAsync();
    for (const style of localStyles) {
        const key = style.id;
        tokenSet.set(key, { 
            name: style.name, 
            styleId: style.id,
            fontFamily: style.fontName ? style.fontName.family : undefined,
            fontStyle: style.fontName ? style.fontName.style : undefined,
            fontSize: style.fontSize
        });
    }

    // 1️⃣ Nível 1: Frame selecionado e seus filhos
    for (const frame of frames) {
        await walkForTextTokens(frame, tokenSet);
    }

    // 2️⃣ Nível 2: Todos os pais do frame até a raiz
    const parentsAnalyzed = new Set<string>();
    for (const frame of frames) {
        let current: BaseNode | null = frame.parent;
        while (current && current.type !== "PAGE") {
            if (!parentsAnalyzed.has(current.id)) {
                if (isSceneNode(current)) {
                    await walkForTextTokens(current, tokenSet);
                }
                parentsAnalyzed.add(current.id);
            }
            current = current.parent;
        }
    }

    // 3️⃣ Nível 3: Todos os irmãos em cada nível da hierarquia
    const siblingsAnalyzed = new Set<string>();
    for (const frame of frames) {
        let current: BaseNode | null = frame;
        while (current && current.type !== "PAGE") {
            if (current.parent && "children" in current.parent) {
                for (const sibling of current.parent.children) {
                    if (isSceneNode(sibling) && !siblingsAnalyzed.has(sibling.id)) {
                        await walkForTextTokens(sibling, tokenSet);
                        siblingsAnalyzed.add(sibling.id);
                    }
                }
            }
            current = current.parent;
        }
    }

    // 4️⃣ Nível 4: Busca na página inteira como fallback
    const pageChildren = figma.currentPage.children;
    for (const child of pageChildren) {
        if (isSceneNode(child) && !siblingsAnalyzed.has(child.id)) {
            await walkForTextTokens(child, tokenSet);
        }
    }

    return Array.from(tokenSet.values());
}

/* ---------- CORE - COLORS ---------- */

async function analyzeColors(frames: (FrameNode | ComponentNode | InstanceNode)[]) {
    figma.ui.postMessage({ type: "analyzing-start" });
    
    const map = new Map<string, { nodeId: string; paint: Paint; isStroke: boolean; node: SceneNode }[]>();

    async function processPaint(node: SceneNode, p: Paint, isStroke: boolean) {
        if (!p || p.visible === false) return;
        if (p.type === "IMAGE" || p.type === "VIDEO" || p.type === "PATTERN") return;
        
        if (p.type === "SOLID" && await hasValidColorToken(node, p)) return;

        let key: string;
        if (p.type === "SOLID") {
            const source = isStroke ? "STROKE" : "FILL";
            key = `${source}_SOLID_${rgbToHex(p.color)}_${p.opacity != null ? p.opacity : 1}`;
        }

        else if (isGradientPaint(p)) key = `GRADIENT_${JSON.stringify(p.gradientStops)}`;
        else return;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, paint: p, isStroke, node });
    }

    let nodeCount = 0;

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        nodeCount++;
        if (nodeCount % 300 === 0) {
            await yieldToUI();
        }

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

    for (const frame of frames) {
        await walk(frame);
    }

    const groups = Array.from(map.values()).map(nodePaints => {
        const firstPaint = nodePaints[0].paint;
        return { hex: firstPaint.type === "SOLID" ? rgbToHex(firstPaint.color) : "Gradiente", nodePaints };
    });

    figma.ui.postMessage({ type: "result-colors", groups });
}

/* ---------- CORE - TYPOGRAPHY ---------- */

async function analyzeTypography(frames: (FrameNode | ComponentNode | InstanceNode)[]) {
    figma.ui.postMessage({ type: "analyzing-start" });
    
    const map = new Map<string, { nodeId: string; node: TextNode; style: CustomTextStyle }[]>();

    async function processTextNode(node: TextNode) {
        if (!showHiddenElements && !node.visible) return;
        
        if (await hasValidTextToken(node)) return;

        const fontName = node.fontName !== figma.mixed ? node.fontName : { family: "Mixed", style: "Mixed" };
        const fontSize = node.fontSize !== figma.mixed ? node.fontSize : "Mixed";
        const fontWeight = node.fontWeight !== figma.mixed ? node.fontWeight : "Mixed";
        const lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "Auto";
        const letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "0";

        const style: CustomTextStyle = {
            fontFamily: fontName.family,
            fontStyle: fontName.style,
            fontSize: fontSize,
            fontWeight: fontWeight,
            lineHeight: lineHeight,
            letterSpacing: letterSpacing
        };

        const key = `${fontName.family}_${fontName.style}`;

        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ nodeId: node.id, node, style });
    }

    let nodeCount = 0;

    async function walk(node: SceneNode): Promise<void> {
        if (!showHiddenElements && !node.visible) return;

        nodeCount++;
        if (nodeCount % 300 === 0) {
            await yieldToUI();
        }

        if (node.type === "TEXT") {
            await processTextNode(node);
        }

        if ("children" in node) {
            for (const c of node.children) {
                if (isSceneNode(c)) await walk(c);
            }
        }
    }

    for (const frame of frames) {
        await walk(frame);
    }

    const groups = Array.from(map.values()).map(nodeStyles => {
        const first = nodeStyles[0].style;
        return { 
            style: first,
            nodeStyles,
            label: `${first.fontFamily} ${first.fontStyle}`
        };
    });

    figma.ui.postMessage({ type: "result-typography", groups });
}

/* ---------- TYPES ---------- */

interface CustomTextStyle {
    fontFamily: string;
    fontStyle: string;
    fontSize: any;
    fontWeight: any;
    lineHeight: any;
    letterSpacing: any;
}

/* ---------- EVENTS ---------- */

figma.on("selectionchange", () => {
    if (ignoringSelectionChange) {
        ignoringSelectionChange = false;
        return;
    }

    const validNodes = figma.currentPage.selection.filter(
        (n): n is FrameNode | ComponentNode | InstanceNode => 
            n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
    );

    if (validNodes.length === 0) {
        figma.ui.postMessage({ type: "empty", clearAll: true });
        return;
    }

    if (currentTab === "colors") {
        analyzeColors(validNodes);
    } else {
        analyzeTypography(validNodes);
    }
});

figma.ui.onmessage = async (msg) => {
    if (msg.type === "select-node") {
        try {
            ignoringSelectionChange = true;
            const node = await figma.getNodeByIdAsync(msg.nodeId);
            if (node && isSceneNode(node)) {
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
            }
        } catch (err) {
            console.error("Erro ao buscar node:", err);
        }
    }

    if (msg.type === "select-multiple-nodes") {
        try {
            ignoringSelectionChange = true;
            const nodes = await Promise.all(msg.nodeIds.map((id: string) => figma.getNodeByIdAsync(id)));
            const validNodes = nodes.filter((n): n is SceneNode => !!n && isSceneNode(n));
            if (validNodes.length) {
                figma.currentPage.selection = validNodes;
                figma.viewport.scrollAndZoomIntoView(validNodes);
            }
        } catch (err) {
            console.error("Erro ao buscar nodes múltiplos:", err);
        }
    }

    if (msg.type === "get-suggested-tokens") {
        try {
            const validNodes = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode => 
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );
            
            if (validNodes.length > 0) {
                if (currentTab === "colors") {
                    const appliedTokens = await collectAppliedColorTokens(validNodes);
                    figma.ui.postMessage({ type: "result-suggested-tokens", tokens: appliedTokens });
                } else {
                    const appliedTokens = await collectAppliedTextTokens(validNodes);
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

    if (msg.type === "apply-token") {
        try {
            const nodeId = msg.nodeId;
            const styleId = msg.styleId;
            const isStroke = msg.isStroke;
            const isText = msg.isText || false;

            const node = await figma.getNodeByIdAsync(nodeId);
            if (!node || !isSceneNode(node)) return;

            if (isText && node.type === "TEXT") {
                // Aplica estilo de texto
                node.textStyleId = styleId;
            } else if (isStroke && "strokes" in node) {
                node.strokes = [];
                node.strokeStyleId = styleId;
            } else if (!isStroke && "fills" in node) {
                node.fills = [];
                node.fillStyleId = styleId;
            }

            // Reanalisa após aplicar o token
            const validNodes = figma.currentPage.selection.filter(
                (n): n is FrameNode | ComponentNode | InstanceNode => 
                    n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
            );
            
            if (validNodes.length > 0) {
                if (currentTab === "colors") {
                    await analyzeColors(validNodes);
                } else {
                    await analyzeTypography(validNodes);
                }
            }
        } catch (err) {
            console.error("Erro ao aplicar token:", err);
        }
    }
    

    if (msg.type === "toggle-hidden") {
        showHiddenElements = msg.value;
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode => 
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );
        if (validNodes.length > 0) {
            if (currentTab === "colors") {
                analyzeColors(validNodes);
            } else {
                analyzeTypography(validNodes);
            }
        }
    }

    if (msg.type === "switch-tab") {
        currentTab = msg.tab;
        const validNodes = figma.currentPage.selection.filter(
            (n): n is FrameNode | ComponentNode | InstanceNode => 
                n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE"
        );
        
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
};

/* ---------- INIT ---------- */
figma.ui.postMessage({ type: "empty", clearAll: true });
figma.ui.postMessage({ type: "init-tab", tab: currentTab });
console.log("Plugin iniciado ✅");