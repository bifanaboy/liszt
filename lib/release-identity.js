export function releaseIdentity(raw) {
    const url = raw.releaseUrl?.trim();
    if (!url)
        return undefined;
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        const segments = parsed.pathname.replace(/\/+$/, "").split("/");
        const numberIndex = segments.findIndex((segment, index) => index < segments.length - 1 && /^\d+$/.test(segment));
        if (numberIndex >= 0) {
            const slug = segments[numberIndex + 1];
            segments[numberIndex + 1] = slug.replace(/[^a-z0-9]/gi, "");
        }
        const path = segments.join("/");
        return `${parsed.host.toLowerCase()}${path}${parsed.search}`.toLowerCase();
    }
    catch {
        return url.toLowerCase();
    }
}
