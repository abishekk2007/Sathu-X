import {
  validateCoordinate,
  toSharedLocation,
  normalizePlace,
  filterValidPlaces,
  derivePlaceQuery,
  createMarkerIcon,
} from "./src/lib/map-utils";
import { buildGoogleMapsSearchLink } from "./src/lib/location";

let passed = 0;
let failed = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    console.log(`FAIL ${label} (expected ${b}, got ${a})`);
  }
}

function assertTrue(actual: unknown, label: string) {
  assertEqual(Boolean(actual), true, label);
}

function assertNull(actual: unknown, label: string) {
  assertEqual(actual, null, label);
}

/* ===================================================================== */
/*  1. Coordinate validation                                             */
/* ===================================================================== */

// Valid finite in-range coordinates pass.
assertEqual(
  validateCoordinate(12.345, -98.77),
  { latitude: 12.345, longitude: -98.77 },
  "COORD_VALID_PASS"
);
assertEqual(
  validateCoordinate(-90, 180),
  { latitude: -90, longitude: 180 },
  "COORD_VALID_EDGES"
);
assertEqual(
  validateCoordinate(90, -180),
  { latitude: 90, longitude: -180 },
  "COORD_VALID_EDGES_NEG"
);

// Invalid coordinates rejected.
assertNull(validateCoordinate(91, 0), "COORD_LAT_TOO_HIGH");
assertNull(validateCoordinate(-91, 0), "COORD_LAT_TOO_LOW");
assertNull(validateCoordinate(0, 181), "COORD_LON_TOO_HIGH");
assertNull(validateCoordinate(0, -181), "COORD_LON_TOO_LOW");
assertNull(validateCoordinate(NaN, 0), "COORD_NAN");
assertNull(validateCoordinate(0, NaN), "COORD_LON_NAN");
assertNull(validateCoordinate(Infinity, 0), "COORD_INFINITY");
assertNull(validateCoordinate(0, -Infinity), "COORD_NEG_INFINITY");
assertNull(validateCoordinate(null, 0), "COORD_NULL_LAT");
assertNull(validateCoordinate(12, undefined), "COORD_UNDEFINED_LON");
assertNull(validateCoordinate("12.3", 0), "COORD_STRING_LAT");
assertNull(validateCoordinate(0, "4"), "COORD_STRING_LON");

/* ===================================================================== */
/*  2. toSharedLocation coarsening                                        */
/* ===================================================================== */

assertEqual(
  toSharedLocation({ latitude: 12.3456789, longitude: -98.7654321 }),
  { latitude: 12.35, longitude: -98.77 },
  "TO_SHARED_COARSENS"
);

/* ===================================================================== */
/*  3. Place normalization                                               */
/* ===================================================================== */

assertEqual(
  normalizePlace({
    id: "abc",
    name: "City Hospital",
    latitude: 12.34,
    longitude: 98.76,
    category: "hospital",
    address: "1 Main St",
    distanceMeters: 820,
  }),
  {
    id: "abc",
    name: "City Hospital",
    latitude: 12.34,
    longitude: 98.76,
    category: "hospital",
    address: "1 Main St",
    distanceMeters: 820,
    sourceUrl: undefined,
    openInGoogleMaps:
      "https://www.google.com/maps/search/?api=1&query=12.34%2C98.76%20City%20Hospital",
  },
  "PLACE_NORMALIZED"
);

// Rejects missing/invalid coords.
assertNull(
  normalizePlace({ name: "No coords", latitude: undefined, longitude: undefined }),
  "PLACE_MISSING_COORDS_NULL"
);
assertNull(
  normalizePlace({ name: "Bad lat", latitude: 999, longitude: 0 }),
  "PLACE_BAD_LAT_NULL"
);
assertNull(normalizePlace(null), "PLACE_NULL_NULL");
assertNull(normalizePlace(undefined), "PLACE_UNDEFINED_NULL");
assertNull(normalizePlace({ latitude: NaN, longitude: 0 }), "PLACE_NAN_NULL");

// Supports alternate lat/lon keys and displayName fallback.
assertEqual(
  normalizePlace({ lat: 1.5, lon: 2.5, displayName: "Aarhus", type: "city" })?.name,
  "Aarhus",
  "PLACE_ALT_KEYS_NAME"
);
assertEqual(
  normalizePlace({ lat: 1.5, lon: 2.5, displayName: "Aarhus", type: "city" })?.category,
  "city",
  "PLACE_ALT_KEYS_CATEGORY"
);

// content is never fabricated.
assertEqual(
  normalizePlace({ name: "No address" })?.address,
  undefined,
  "PLACE_NO_ADDRESS_UNDEFINED"
);
assertEqual(
  normalizePlace({ name: "No distance", latitude: 1, longitude: 1 })?.distanceMeters,
  undefined,
  "PLACE_NO_DISTANCE_UNDEFINED"
);

/* ===================================================================== */
/*  4. Marker filtering                                                  */
/* ===================================================================== */

const mixed = filterValidPlaces([
  { name: "Valid 1", latitude: 1.1, longitude: 1.1 },
  { name: "Invalid NaN", latitude: NaN, longitude: 0 },
  { name: "Invalid range", latitude: 95, longitude: 0 },
  { name: "Valid 2", latitude: 2.2, longitude: -2.2 },
  {},
  null as unknown as Record<string, unknown>,
  { name: "String coords", latitude: "12", longitude: "34" },
] as unknown as Array<Record<string, unknown>>);
assertEqual(mixed.length, 2, "FILTER_DROPS_INVALID");
assertEqual(mixed[0].name, "Valid 1", "FILTER_KEEPS_FIRST_VALID");
assertEqual(mixed[1].name, "Valid 2", "FILTER_KEEPS_SECOND_VALID");

assertEqual(filterValidPlaces([]).length, 0, "FILTER_EMPTY_ARRAY");
assertEqual(filterValidPlaces(null).length, 0, "FILTER_NULL");
assertEqual(filterValidPlaces(undefined).length, 0, "FILTER_UNDEFINED");

/* ===================================================================== */
/*  5. Google Maps URL generation (reused buildGoogleMapsSearchLink)     */
/* ===================================================================== */

const url = buildGoogleMapsSearchLink({ latitude: 12.3, longitude: 98.7 }, "City Hospital");
assertTrue(url.startsWith("https://www.google.com/maps/search/?api=1&query="), "GMAPS_HTTPS_OMNIBOX");
assertTrue(url.includes("12.3") && url.includes("98.7"), "GMAPS_HAS_PIN");
assertTrue(url.includes("City%20Hospital"), "GMAPS_HAS_PLACE_HINT");

// The normalized place exposes its own Google Maps link.
const place = normalizePlace({ name: "Pharmacy", latitude: 3.3, longitude: 4.4 });
assertTrue((place?.openInGoogleMaps ?? "").includes("3.3"), "PLACE_GMAPS_HAS_LAT");
assertTrue((place?.openInGoogleMaps ?? "").includes("4.4"), "PLACE_GMAPS_HAS_LON");

// No place -> no link.
assertEqual(
  normalizePlace({ name: "X", latitude: null as unknown as number, longitude: null as unknown as number })?.openInGoogleMaps,
  undefined,
  "PLACE_NO_LINK"
);

/* ===================================================================== */
/*  6. Empty place results                                               */
/* ===================================================================== */

assertEqual(filterValidPlaces([{ name: "All invalid", latitude: 999, longitude: 999 }]).length, 0, "EMPTY_ALL_INVALID");

/* ===================================================================== */
/*  7. derivePlaceQuery                                                  */
/* ===================================================================== */

assertEqual(derivePlaceQuery("find hospitals near me"), "hospitals", "QUERY_HOSPITALS");
assertEqual(derivePlaceQuery("coffee shops around here"), "coffee shops", "QUERY_COFFEE");
assertEqual(derivePlaceQuery("closest pharmacy nearby"), "pharmacy", "QUERY_PHARMACY");
assertEqual(derivePlaceQuery("show me cafés near me"), "cafés", "QUERY_CAFES");
assertEqual(derivePlaceQuery("find ATMs near me"), "ATMs", "QUERY_ATMS");
assertNull(derivePlaceQuery("what is the weather in chennai"), "QUERY_NOT_NEARME_NULL");
assertNull(derivePlaceQuery("hello there"), "QUERY_PLAIN_NULL");
assertNull(derivePlaceQuery(""), "QUERY_EMPTY_NULL");
assertNull(derivePlaceQuery("  "), "QUERY_WHITESPACE_NULL");
assertNull(derivePlaceQuery("find near me"), "QUERY_NULL_AFTER_STRIP");

/* ===================================================================== */
/*  8. Marker icon factory                                               */
/* ===================================================================== */

const icon = createMarkerIcon("#ef4444", 28);
assertTrue(icon.includes("<svg"), "ICON_IS_SVG");
assertTrue(icon.includes("#ef4444"), "ICON_IS_COLOR");
assertTrue(icon.includes('width="28"') && icon.includes('height="28"'), "ICON_SIZE");

/* ===================================================================== */

console.log(`\nPhase 8 tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
else console.log("Phase 8 test suite PASSED");
