# **Dunkeld Through Time**

An interactive 3D historical map of Dunkeld, Scotland, covering the period from 1200 to 2026. The application combines historical cartography, geographical data and procedural 3D rendering to reconstruct how the town and its surrounding landscape have evolved.

Built using **MapLibre GL JS** and **Three.js**, it features:

- A year slider for exploring historical changes to buildings, woodland, roads and waterways.
- Georeferenced historical map overlays with adjustable opacity.
- 3D terrain using elevation data.
- Procedurally generated 3D trees, flowing water, roads, tracks and railway infrastructure.
- Optional 3D building models.
- Seasonal landscape appearances, including ground textures and vegetation colours.
- Animated mountain mist.
- A historical events panel with descriptions, dates, optional images and map navigation.
- Adjustable rendering quality and visibility controls.

## **Project files and dependencies**

### **Core application**

| File              | Description                                                                                                                                                                                  | Required |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `index.html`      | Main application, UI, map configuration, rendering and animation logic.                                                                                                                      | Yes      |
| `viewer_utils.js` | JavaScript utility module providing geographical calculations, geometry processing, terrain handling, tree generation, water and transport mesh construction, and other 3D helper functions. | Yes      |

### **Geographical and historical data**

| File                       | Description                                                                                                      | Required                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `base.geojson`             | Base geographical features, including land use, water, rivers and streams. Primarily derived from OpenStreetMap. | Optional, but important |
| `buildings_master.geojson` | Building footprints, heights, historical date ranges, metadata and optional 3D model references.                 | Optional                |
| `buildings.geojson`        | Fallback building dataset when the master dataset is unavailable.                                                | Optional                |
| `forest4.geojson`          | Preferred woodland dataset, containing forest polygons and tree-related attributes.                              | Optional                |
| `forests.geojson`          | Alternative woodland dataset if `forest4.geojson` is unavailable.                                                | Optional                |
| `roads.geojson`            | Roads, tracks, paths and railway features, including classifications and historical properties.                  | Optional                |
| `events.json`              | Historical events, descriptions, dates, geographical coordinates and optional image references.                  | Optional                |
| `maps.json`                | Configuration of historical map overlays, including tile locations, date ranges and attribution.                 | Optional                |

### **Terrain data**

| File / Directory               | Description                                                                         | Required |
| ------------------------------ | ----------------------------------------------------------------------------------- | -------- |
| `tiles/meta.json`              | Metadata describing the locally available elevation dataset, including zoom levels. | Optional |
| `tiles_masked/{z}/{x}/{y}.png` | Local terrain elevation tiles used to construct the detailed heightfield.           | Optional |

When local elevation data is unavailable, the application falls back to the global Terrarium elevation tile service.

### **Dynamically loaded assets**

These assets are referenced by the geographical and historical data rather than directly by the application.

| Location / Property     | Description                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models/*.glb`          | Optional 3D building models referenced by the `model` property of building features. Loaded when their corresponding historical date range is reached. |
| `events.json` → `image` | Optional images displayed alongside historical events.                                                                                                 |
| `maps.json` → `tiles`   | Raster tile sources used for historical map overlays.                                                                                                  |

Building models support additional placement properties, including rotation, scale and vertical offset.

## **Third-party dependencies**

The application retrieves the following libraries externally:

| Dependency          | Version | Purpose                                      |
| ------------------- | ------- | -------------------------------------------- |
| MapLibre GL JS      | 4.7.1   | Interactive map rendering and terrain.       |
| Three.js            | 0.160.0 | Custom 3D rendering and procedural geometry. |
| Three.js GLTFLoader | 0.160.0 | Loading optional GLB building models.        |

These are loaded from `unpkg.com`.

## **Editing and extending the map**

The application is designed to be extended by editing its configuration, geographical datasets and historical event data. Most content changes do not require modifying the JavaScript application itself.

### **1. Changing application settings**

Several important settings can be changed directly in `index.html`, near the beginning of the main JavaScript module, under the `settings` section.

| Variable              | Purpose                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `DEFAULT_YEAR`        | Year displayed when the application starts.                                           |
| `AREA_CENTRE`         | Centre coordinates of the mapped area.                                                |
| `AREA_HALF_M`         | Half-width and half-height of the mapped area, in metres.                             |
| `MODERN_FROM`         | Default starting year for buildings without a specified `from_year` (currently 2000). |
| `FOREST_UNDATED_FROM` | Default starting year for woodland without a specified `from_year`.                   |
| `IDLE_MS`             | Time before the map automatically returns to its initial camera position.             |
| `IDLE_RESETS_YEAR`    | Whether the year resets when the idle timer expires.                                  |
| `FLOW_SPEED`          | Multiplier controlling the apparent speed of flowing water.                           |
| `FLOW_REVERSE`        | Reverses the direction of water flow.                                                 |
| `MIST_FPS`            | Update rate for animated mountain mist.                                               |

**Changing the historical timeline**

The year slider is defined separately in the HTML:

```
<input id="yearSlider" type="range"
       min="1200" max="2026" step="1" value="2026">
```

To extend the timeline, change the `min` or `max` values as required. Also update `DEFAULT_YEAR` to the desired starting year. The displayed year text can be updated for consistency, although it is refreshed automatically when the application loads.

The `MODERN_FROM` setting is separate from the slider range: it determines how undated buildings are treated historically. The forest equivalent is controlled by `FOREST_UNDATED_FROM`.

Individual features can have their own historical date ranges using `from_year` and `to_year`. Both endpoints are inclusive, and a null `to_year` means the feature remains visible indefinitely.&#x20;

index(2).html

index(2).html



Other settings, including rendering quality, tree limits, mist density and animation frame rates, can be adjusted in the `TIERS` configuration.

### **2. Adding geographical features using QGIS**

Buildings, forests and roads are stored as GeoJSON datasets. New features can be digitised and their attributes edited directly in [QGIS](https://qgis.org/?utm_source=chatgpt.com).

The general workflow is:

1. Open the relevant existing GeoJSON file in QGIS.
2. Make a backup before editing.
3. Select the layer and enable editing.
4. Use the appropriate **Add Polygon Feature** or **Add Line Feature** tool.
5. Draw the new feature on the map.
6. Enter its attributes in the feature form.
7. Save the layer edits.

QGIS supports adding and editing vector geometries and their associated attributes through its digitising tools.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.qgis.org\&sz=32)

QGIS Documentation documentation+1



**Coordinate reference system:** Use WGS 84 (EPSG:4326) when exporting the final GeoJSON. The application expects geographical coordinates in longitude/latitude order.

#### **Adding a building**

**File:** `buildings_master.geojson`

Buildings should be represented as polygon or multipolygon geometries outlining their footprints.

Important attributes:

| Attribute   | Description                                             |
| ----------- | ------------------------------------------------------- |
| `id`        | Unique identifier for the building.                     |
| `name`      | Building name.                                          |
| `btype`     | Building type, e.g. church, house or bridge.            |
| `h`         | Building height in metres.                              |
| `min_h`     | Height of the building's base above ground level.       |
| `from_year` | Year the building first appears.                        |
| `to_year`   | Year the building disappears, or null if still present. |
| `date_src`  | Source or justification for the historical dating.      |
| `src`       | Source of the building information.                     |
| `manual`    | Indicates manually created or adjusted data.            |
| `notes`     | Additional information.                                 |

Optional attributes allow a detailed 3D model to be used instead of the standard extruded building representation:

| Attribute     | Description                                               |
| ------------- | --------------------------------------------------------- |
| `model`       | Path to a GLB model, e.g. `models/dunkeld_bridge_v2.glb`. |
| `model_rot`   | Model rotation in degrees.                                |
| `model_scale` | Model scaling factor.                                     |
| `model_dz`    | Vertical offset in metres.                                |

The building footprint determines the model's geographical placement. Buildings without a model are rendered using their footprint and height attributes.

#### **Adding a forest**

**File:** `forest4.geojson` (preferred) or `forests.geojson` (fallback).

Forests should be represented as polygon or multipolygon geometries outlining the woodland area.

Important attributes:

| Attribute   | Description                                               |
| ----------- | --------------------------------------------------------- |
| `id`        | Unique identifier for the woodland feature.               |
| `name`      | Woodland name.                                            |
| `tree_type` | `broadleaf`, `conifer` or `mixed`.                        |
| `density`   | Approximate tree density, expressed as trees per hectare. |
| `tree_h`    | Average tree height in metres.                            |
| `from_year` | Year the woodland first appears.                          |
| `to_year`   | Year the woodland disappears, or null if still present.   |
| `date_src`  | Source or justification for the dating.                   |
| `src`       | Data source.                                              |
| `notes`     | Additional information.                                   |

The application procedurally generates individual trees inside each forest polygon. Tree density and average height are controlled by the attributes rather than individual tree geometries.

If `density` is missing or invalid, the application defaults to 80 trees per hectare. If `tree_h` is missing or invalid, the default average height is 12 metres. An unspecified tree type is treated as mixed woodland.&#x20;

#### **Adding a road or railway**

**File:** `roads.geojson`

Roads, tracks, paths and railways should be represented as LineString or MultiLineString geometries.

Important attributes:

| Attribute       | Description                                              |
| --------------- | -------------------------------------------------------- |
| `id`            | Unique identifier.                                       |
| `name`          | Road or route name.                                      |
| `kind`          | Feature type, e.g. `road` or `rail`.                     |
| `cls`           | Road classification: `major`, `minor` or `track`.        |
| `surface`       | Surface type, e.g. `asphalt`, `cobblestone` or `gravel`. |
| `from_year`     | Year the route first appears.                            |
| `to_year`       | Year the route disappears, or null if still present.     |
| `date_src`      | Historical dating source.                                |
| `documented_by` | Relevant documentation or reference.                     |
| `src`           | Data source.                                             |
| `notes`         | Additional information.                                  |

For compatibility with both the 2D map and 3D transport rendering, use `kind: "road"` with `cls: "major"`, `"minor"` or `"track"`. For railways, use `kind: "rail"`.

Road surfaces change historically according to their classification:

| Road classification | Cobblestones introduced | Tarmac introduced |
| ------------------- | ----------------------- | ----------------- |
| Major               | 1750                    | 1925              |
| Minor               | 1800                    | 1940              |
| Tracks and trails   | Never                   | Never             |

These are application defaults rather than individually researched dates for every road. The `surface` attribute can restrict the assumed progression: unpaved surfaces remain dirt, while cobblestone surfaces do not progress to tarmac.&#x20;

### **3. Adding historical events**

**File:** `events.json`

Historical events are maintained separately from the geographical datasets in a JSON file.

Each event is an entry in the `events` array. A basic example:

```
{
  "events": [
    {
      "title": "The Hermitage established",
      "from_year": 1757,
      "to_year": 1758,
      "text": "A summerhouse and retreat was constructed above the Black Linn Falls.",
      "lon": -3.61401,
      "lat": 56.55748
    }
  ]
}
```

The available properties are:

| Attribute       | Description                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| `title`         | Event title (required).                                                        |
| `from_year`     | Starting year (required).                                                      |
| `to_year`       | Ending year. Optional; defaults to `from_year`, making it a single-year event. |
| `text`          | Longer historical description.                                                 |
| `lon`           | Longitude of the event location.                                               |
| `lat`           | Latitude of the event location.                                                |
| `zoom`          | Map zoom level when navigating to the event.                                   |
| `image`         | Optional image URL or local image path.                                        |
| `image_caption` | Caption displayed beneath the image.                                           |

Events automatically appear in chronological order in the side panel whenever their date range overlaps the currently selected year.

Where geographical coordinates are supplied and fall within the mapped area, a **Show on map** button is provided, allowing the user to fly directly to the event location.

Images are optional: events can be entirely text-based.&#x20;

index(2).html



**A general note on editing data:** Keep the existing attribute names and data conventions consistent when adding features. In particular, use unique IDs, numeric year and height values, and null rather than zero for genuinely unknown or open-ended dates. After saving GeoJSON or JSON changes, reload the webpage to see the updates. Changes to the application settings themselves require editing `index.html`, but ordinary additions to buildings, forests, roads and events do not.
