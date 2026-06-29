// The real spiral-map art is supplied via EXPO_PUBLIC_MAP_BACKGROUND_URI (a
// hosted image) in production. When unset, the Map screen renders a branded
// in-app fallback rather than a third-party placeholder host — a missing env
// var must never ship an external "600 × 800" placehold.co image (#766).
export const MAP_BACKGROUND_URI: string | null = process.env.EXPO_PUBLIC_MAP_BACKGROUND_URI ?? null;
