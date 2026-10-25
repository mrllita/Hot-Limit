/* JavaScript connects the HTML controls to the real geographic data.
   Read init(), then selectTract(), then the button event listeners. */
(() => {
  "use strict";
  // Files resolve relative to this script, including after copying the folder.
  const scriptBase = new URL(".", document.currentScript.src);

  const INDICATORS = {
    vulnerability: "Overall burden percentile",
    pollution_pctl: "Pollution percentile",
    poverty_pctl: "Poverty percentile",
    asthma_pctl: "Asthma indicator percentile",
    population_char_pctl: "Population characteristics percentile"
  };
  const $ = id => document.getElementById(id);
  const css = getComputedStyle(document.body);
  const colors = ["--em-low", "--em-mid-low", "--em-mid", "--em-mid-high", "--em-high"].map(key => css.getPropertyValue(key).trim());
  const missingColor = css.getPropertyValue("--em-unavailable").trim();
  const dotColor = css.getPropertyValue("--em-cooling-dot").trim();
  let map, geoLayer, coolingLayer, userMarker, userAccuracy, nearestMarker;
  let selectedId = null;
  let selectedDescription = { example: false, context: "" };
  let activeIndicator = "vulnerability";
  let features = [];
  const layersById = new Map();
  const coolingMarkers = [];
  const placeCache = new Map();
  let searchSequence = 0, searchController = null, searchMarker = null;

  function setStatus(message, error = false) {
    $("em-status").textContent = message;
    $("em-status").classList.toggle("em-error", error);
  }
  function valueText(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "Unavailable";
  }
  function colorFor(value) {
    // null is missing; zero is a valid percentile. Never convert null to 0.
    if (typeof value !== "number" || !Number.isFinite(value)) return missingColor;
    return colors[Math.max(0, Math.min(4, Math.floor(value / 20)))];
  }
  function tractStyle(feature) {
    const isSelected = feature.properties.tract_id === selectedId;
    return {
      fillColor: colorFor(feature.properties[activeIndicator]), fillOpacity: 1,
      color: isSelected ? "#164b38" : "#ffffff", opacity: 1,
      weight: isSelected ? 3 : .5
    };
  }
  function selectTract(feature, { zoom = false, example = false, context = "" } = {}) {
    selectedId = feature.properties.tract_id;
    selectedDescription = { example, context };
    const p = feature.properties;
    geoLayer.setStyle(tractStyle);
    const layer = layersById.get(selectedId);
    layer.bringToFront();
    if (zoom) map.fitBounds(layer.getBounds(), { padding: [35, 35], maxZoom: 13 });
    $("em-selection-label").textContent = example ? "Example selected area" : "Selected area";
    $("em-area-name").textContent = p.name;
    $("em-area-context").textContent = context || "Census tract in Los Angeles County";
    const score = p[activeIndicator];
    $("em-main-score").textContent = valueText(score);
    $("em-main-score").classList.toggle("em-unavailable-score", typeof score !== "number");
    $("em-score-label").textContent = INDICATORS[activeIndicator];
    $("em-pollution").textContent = valueText(p.pollution_pctl);
    $("em-poverty").textContent = valueText(p.poverty_pctl);
    $("em-population").textContent = typeof p.population === "number" ? p.population.toLocaleString("en-US") : "Unavailable";
    $("em-geoid").textContent = `GEOID ${p.tract_id}`;
    $("em-pop-char").textContent = valueText(p.population_char_pctl);
    $("em-asthma").textContent = valueText(p.asthma_pctl);
    $("em-elderly").textContent = typeof p.elderly_pct === "number" ? `${p.elderly_pct.toFixed(1)}%` : "Unavailable";
    document.dispatchEvent(new CustomEvent("hotlimit:tract-selected", { detail: { tractId: selectedId, properties: { ...p } } }));
  }
  function updateIndicator(key) {
    if (!INDICATORS[key]) return;
    activeIndicator = key;
    document.querySelectorAll("[data-indicator]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.indicator === key));
    });
    $("em-legend-title").textContent = INDICATORS[key];
    geoLayer.setStyle(tractStyle);
    if (selectedId) selectTract(layersById.get(selectedId).feature, selectedDescription);
    const unavailable = features.filter(f => typeof f.properties[key] !== "number").length;
    setStatus(`${features.length.toLocaleString()} LA County tracts · ${INDICATORS[key]} · ${unavailable} with unavailable data`);
  }
  function searchTract(event) {
    event.preventDefault();
    const query = $("em-search-input").value.trim();
    if (!query) { setStatus("Enter a census tract number, such as 2080.00 or 06037208000.", true); return; }
    let found = features.find(f => f.properties.tract_id === query);
    const short = query.toLowerCase().replace(/^census\s+tract\s*/, "").trim();
    if (!found && /^\d{1,4}(?:\.\d{1,2})?$/.test(short)) {
      found = features.find(f => Number(f.properties.name.replace("Census tract ", "")) === Number(short));
    }
    if (!found) { setStatus("No matching LA County tract. Try 2080.00 or the full 11-digit tract ID.", true); return; }
    selectTract(found, { zoom: true });
    setStatus(`Selected ${found.properties.name}.`);
  }
  // Place-name search: name -> geographic point -> census tract at that point.
  function normalizedName(text) {
    return String(text).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function findTractAt(lon, lat) {
    // Check bounding boxes first, then the actual polygon (including holes).
    return features.find(feature => layersById.get(feature.properties.tract_id)
      .getBounds().contains([lat, lon]) && containsPoint(feature, lon, lat));
  }
  function setSearchBusy(busy) {
    $("em-search-button").disabled = busy;
    $("em-search-button").textContent = busy ? "Searching…" : "Search";
    $("em-search-form").setAttribute("aria-busy", String(busy));
  }
  function clearSearchResults() {
    $("em-place-results").hidden = true;
    $("em-place-list").replaceChildren();
  }
  function chooseSearchResult(result) {
    if (searchMarker) { searchMarker.remove(); searchMarker = null; }
    selectTract(result.area, {
      context: result.kind === "Cooling center" ? "Near " + result.name
        : "Tract at the mapped location for " + result.name
    });
    map.setView([result.lat, result.lon], result.kind === "Cooling center" ? 14 : 12);
    if (result.marker) {
      if (!map.hasLayer(coolingLayer)) { coolingLayer.addTo(map); $("em-cooling-toggle").checked = true; }
      result.marker.openPopup();
    } else {
      const label = document.createElement("span");
      label.textContent = result.name + " — " + result.kind;
      searchMarker = L.circleMarker([result.lat, result.lon], {
        pane: "location", radius: 9, color: "#07151d", weight: 3,
        fillColor: "white", fillOpacity: .5
      }).addTo(map).bindTooltip(label);
    }
    clearSearchResults();
    $("em-search-input").value = result.name;
    setStatus("Selected " + result.area.properties.name + " at " + result.name
      + ". Scores apply to this census tract.");
  }
  function showSearchResults(results) {
    clearSearchResults();
    results.slice(0, 8).forEach(result => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button"; button.className = "em-place-result";
      const title = document.createElement("strong"); title.textContent = result.name;
      const detail = document.createElement("span"); detail.textContent = result.description;
      button.append(title, detail);
      button.addEventListener("click", () => chooseSearchResult(result));
      item.append(button); $("em-place-list").append(item);
    });
    $("em-place-results").hidden = false;
  }
  function matchingCoolingCenters(query) {
    const key = normalizedName(query);
    return coolingMarkers.filter(entry => normalizedName(entry.center.name).includes(key)
      || (key.length >= 5 && normalizedName(entry.center.address).includes(key)))
      .map(entry => {
        const c = entry.center;
        return { name: c.name, lat: c.lat, lon: c.lon, kind: "Cooling center",
          description: "Cooling center · " + c.address + ", " + c.city,
          area: findTractAt(c.lon, c.lat), marker: entry.marker };
      }).filter(result => result.area);
  }
  async function lookupPlaceNames(query, signal) {
    const key = normalizedName(query);
    if (placeCache.has(key)) return placeCache.get(key);
    // Open-Meteo / GeoNames returns place coordinates, not environmental scores.
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", query.includes(",") ? query : query + ", California");
    url.searchParams.set("countryCode", "US");
    url.searchParams.set("count", "20");
    url.searchParams.set("language", "en");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Place lookup unavailable");
    const data = await response.json();
    if (data.error) throw new Error("Place lookup unavailable");
    const seen = new Set(), matches = [];
    (Array.isArray(data.results) ? data.results : []).forEach(place => {
      if (place.country_code !== "US" || !/^PPL/.test(place.feature_code || "")
        || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return;
      const area = findTractAt(place.longitude, place.latitude);
      const identity = normalizedName(place.name + " " + place.admin1 + " " + place.admin2);
      if (!area || seen.has(identity)) return;
      seen.add(identity);
      const kind = place.feature_code === "PPLX" ? "Neighborhood" : "City / place";
      matches.push({ name: place.name, lat: place.latitude, lon: place.longitude, area, kind,
        description: kind + " · Los Angeles County, California" });
    });
    if (placeCache.size >= 50) placeCache.delete(placeCache.keys().next().value);
    placeCache.set(key, matches);
    return matches;
  }
  async function searchMap(event) {
    event.preventDefault();
    const sequence = ++searchSequence;
    if (searchController) searchController.abort();
    clearSearchResults();
    const query = $("em-search-input").value.trim();
    if (!normalizedName(query)) { setSearchBusy(false); setStatus("Enter a place name or census tract number, such as Echo Park or 2080.00.", true); return; }
    if (/^\d{11}$/.test(query) || /^(?:census\s+tract\s+)?\d{1,4}(?:\.\d{1,2})?$/i.test(query)) {
      setSearchBusy(false); searchTract(event); return;
    }
    const local = matchingCoolingCenters(query);
    const exact = local.filter(result => normalizedName(result.name) === normalizedName(query));
    if (exact.length === 1) { setSearchBusy(false); chooseSearchResult(exact[0]); return; }
    // Existing facility addresses can match locally; general street addresses are not geocoded.
    if (/^\d+\s+\D/.test(query)) {
      setSearchBusy(false);
      if (local.length) { showSearchResults(local); setStatus("Choose a listed cooling center below."); }
      else setStatus("Search a city or neighborhood name, such as Echo Park. General street-address lookup is not included.", true);
      return;
    }
    setSearchBusy(true); setStatus("Looking for matching LA County places…");
    const controller = new AbortController(); searchController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
    try {
      const places = await lookupPlaceNames(query, controller.signal);
      if (sequence !== searchSequence) return;
      const results = [...places, ...local].slice(0, 8);
      if (!results.length) setStatus("No matching place in this LA County dataset. Try a city, neighborhood, cooling-center name, or tract number.", true);
      else { showSearchResults(results); setStatus(results.length + " matching locations. Choose one below."); }
    } catch (error) {
      if (sequence !== searchSequence) return;
      if (local.length) { showSearchResults(local); setStatus("Online place lookup is unavailable. Choose a cooling-center match below."); }
      else setStatus(timedOut ? "Place lookup timed out. Try again, or use tract search or the map."
        : "Place lookup could not connect. Tract search, map selection, and device location still work.", true);
    } finally {
      clearTimeout(timeout);
      if (sequence === searchSequence) { searchController = null; setSearchBusy(false); }
    }
  }
  function setupPlaceSearch() {
    // Also updates the original HTML, so replacing JS/CSS preserves your HTML edits.
    const input = $("em-search-input");
    input.placeholder = "Place name or tract number"; input.maxLength = 100;
    document.querySelector('label[for="em-search-input"]').textContent = "LA County place name, cooling center, or census tract number";
    $("em-search-button").textContent = "Search";
    const section = document.createElement("section");
    section.id = "em-place-results"; section.className = "em-place-results"; section.hidden = true;
    section.setAttribute("aria-label", "Matching locations");
    const heading = document.createElement("h2"); heading.textContent = "Matching locations";
    const help = document.createElement("p"); help.textContent = "Choose a location. The map shows the census tract at its mapped point; scores vary across a city or neighborhood.";
    const list = document.createElement("ul"); list.id = "em-place-list";
    section.append(heading, help, list);
    document.querySelector(".em-search-row").after(section);
    input.addEventListener("input", () => {
      ++searchSequence; if (searchController) searchController.abort();
      searchController = null; setSearchBusy(false); clearSearchResults();
    });
    const credit = document.createElement("p");
    credit.append("Place-name lookup: ");
    for (const [index, info] of [["Open-Meteo", "https://open-meteo.com/en/docs/geocoding-api"], ["GeoNames", "https://www.geonames.org/"]].entries()) {
      if (index) credit.append(" / ");
      const link = document.createElement("a"); link.textContent = info[0]; link.href = info[1];
      link.target = "_blank"; link.rel = "noopener noreferrer"; credit.append(link);
    }
    document.querySelector(".em-footer").append(credit);
  }
  function coolingPopup(center) {
    // Source strings go into textContent, not HTML.
    const box = document.createElement("div"); box.className = "em-popup";
    const title = document.createElement("h3"); title.textContent = center.name; box.append(title);
    for (const text of [center.address, center.city, center.hours ? `Listed hours: ${center.hours}` : "Hours unavailable.", "Listed cooling center. Confirm current hours and availability with the provider."]) {
      const p = document.createElement("p"); p.textContent = text; box.append(p);
    }
    const link = document.createElement("a"); link.href = "https://ready.lacounty.gov/heat/"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "LA County cooling-center information"; box.append(link);
    return box;
  }

  // GeoJSON stores [longitude, latitude]. A polygon can contain interior holes.
  function inRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inPolygon(point, rings) {
    return inRing(point, rings[0]) && !rings.slice(1).some(hole => inRing(point, hole));
  }
  function containsPoint(feature, lon, lat) {
    const geometry = feature.geometry;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(polygon => inPolygon([lon, lat], polygon));
  }
  function showPosition(position) {
    $("em-locate").disabled = false;
    $("em-locate").textContent = "Use my location";
    const { latitude: lat, longitude: lon, accuracy } = position.coords;
    if (userMarker) { userMarker.remove(); userMarker = null; }
    if (userAccuracy) { userAccuracy.remove(); userAccuracy = null; }
    nearestMarker = null;
    $("em-nearest-card").hidden = true;
    const area = findTractAt(lon, lat);
    if (!area) { setStatus("Your location is outside this LA County tract dataset. You can still explore the map.", true); return; }
    userMarker = L.circleMarker([lat, lon], { pane: "location", radius: 8, color: "white", weight: 3, fillColor: "#147bd1", fillOpacity: 1 }).addTo(map).bindTooltip("Your approximate location");
    if (Number.isFinite(accuracy)) userAccuracy = L.circle([lat, lon], { pane: "location", radius: accuracy, color: "#147bd1", weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
    selectTract(area, { context: "Area at your approximate device location" });
    map.setView([lat, lon], 13);
    nearestMarker = coolingMarkers.reduce((best, current) => !best || map.distance([lat, lon], current.marker.getLatLng()) < map.distance([lat, lon], best.marker.getLatLng()) ? current : best, null);
    if (nearestMarker) {
      const miles = map.distance([lat, lon], nearestMarker.marker.getLatLng()) / 1609.344;
      $("em-nearest-card").hidden = false;
      $("em-nearest-name").textContent = nearestMarker.center.name;
      $("em-nearest-distance").textContent = `${miles.toFixed(1)} miles away, straight-line distance.`;
    }
    setStatus(`Selected ${area.properties.name} at your approximate location.`);
  }
  function locateUser() {
    if (!navigator.geolocation) { setStatus("Location is unavailable in this browser. Use tract search instead.", true); return; }
    if (!window.isSecureContext) { setStatus("Location needs HTTPS or localhost. You can still select or search a tract.", true); return; }
    $("em-locate").disabled = true; $("em-locate").textContent = "Finding location…";
    // Request only after a button click. Coordinates remain in this page's memory.
    navigator.geolocation.getCurrentPosition(showPosition, error => {
      $("em-locate").disabled = false; $("em-locate").textContent = "Use my location";
      const message = error.code === 1 ? "Location permission was declined. You can still select or search a tract." : "Location could not be found. You can still select or search a tract.";
      setStatus(message, true);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 0 });
  }
  async function loadJSON(path) {
    const response = await fetch(new URL(path, scriptBase));
    if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
    return response.json();
  }
  async function init() {
    try {
      if (!window.L) throw new Error("Leaflet did not load.");
      const [tracts, centers] = await Promise.all([loadJSON("data/la_tracts.geojson"), loadJSON("data/cooling_centers.json")]);
      features = tracts.features;
      map = L.map("em-map", { minZoom: 7, maxZoom: 17, scrollWheelZoom: false });
      map.createPane("cooling"); map.getPane("cooling").style.zIndex = 450;
      map.createPane("location"); map.getPane("location").style.zIndex = 460;
      map.attributionControl.addAttribution('Data: <a href="https://oehha.ca.gov/calenviroscreen/report/calenviroscreen-40">OEHHA</a> / LA County');
      geoLayer = L.geoJSON(tracts, {
        style: tractStyle,
        onEachFeature(feature, layer) {
          layersById.set(feature.properties.tract_id, layer);
          layer.bindTooltip(() => `${feature.properties.name}: ${valueText(feature.properties[activeIndicator])}`, { sticky: true });
          layer.on("click", () => { selectTract(feature); setStatus(`Selected ${feature.properties.name}.`); });
        }
      }).addTo(map);
      coolingLayer = L.layerGroup().addTo(map);
      centers.forEach(center => {
        const marker = L.circleMarker([center.lat, center.lon], { pane: "cooling", radius: 4.5, fillColor: dotColor, fillOpacity: 1, color: "white", weight: 1.2 });
        marker.bindPopup(coolingPopup(center)).addTo(coolingLayer);
        coolingMarkers.push({ marker, center });
      });
      // Start near the example tract; narrow maps use closer neighborhood detail.
      // The county button still shows every included tract.
      map.setView([34.06741, -118.25722], map.getSize().x < 600 ? 11 : 10);
      setupPlaceSearch();
      $("em-search-form").addEventListener("submit", searchMap);
      $("em-locate").addEventListener("click", locateUser);
      $("em-county-view").addEventListener("click", () => map.fitBounds(geoLayer.getBounds(), { padding: [15, 15] }));
      $("em-cooling-toggle").addEventListener("change", event => event.target.checked ? map.addLayer(coolingLayer) : map.removeLayer(coolingLayer));
      $("em-nearest-button").addEventListener("click", () => {
        if (!nearestMarker) return;
        if (!map.hasLayer(coolingLayer)) { map.addLayer(coolingLayer); $("em-cooling-toggle").checked = true; }
        map.setView(nearestMarker.marker.getLatLng(), 14); nearestMarker.marker.openPopup();
      });
      document.querySelectorAll("[data-indicator]").forEach(button => button.addEventListener("click", () => updateIndicator(button.dataset.indicator)));
      document.querySelectorAll(".em-shell button, .em-shell input").forEach(control => { control.disabled = false; });
      updateIndicator("vulnerability");
      const example = layersById.get("06037208000");
      if (example) selectTract(example.feature, { example: true, context: "Near Echo Park Branch Library · example" });
    } catch (error) {
      console.error(error);
      setStatus("Map could not load. Run this folder with a local web server and keep the data and vendor folders beside these files. See START_HERE.md.", true);
    }
  }
  init();
})();
