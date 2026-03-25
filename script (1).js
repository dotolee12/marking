const STORAGE_KEY = "giloa-v7";
const FOG_ALPHA = 0.8;
const FOG_RADIUS_M = 18;
const FOG_FADE_START = 0.4;
const FOG_FADE_INTERVAL_MS = 10 * 60 * 1000;
const FOG_FADE_STEP = 0.01;
const MIN_MOVE_M = 8;
const MAX_ACCURACY_M = 45;
const STAY_ACCURACY_FACTOR = 0.6;
const MAX_STAY_RADIUS_M = 18;
const SAVE_DELAY_MS = 800;
const MERGE_DISTANCE_M = 6;
const MERGE_TIME_GAP_MS = 2 * 60 * 1000;
const MAX_PATH_POINTS = 5000;

let isRecording = false;
let currentPos = null;
let pathCoordinates = [];
let memories = [];
let totalDistance = 0;
let playerMarker = null;
let watchId = null;
let saveTimer = null;
let rafId = null;
let memoryMarkers = new Map();

const recBtn = document.getElementById("rec-btn");
const recStatusBox = document.getElementById("rec-status-box");

const map = L.map("map", { zoomControl: false, attributionControl: false })
    .setView([37.5665, 126.9780], 16);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);

const fogCanvas = document.getElementById("fog-canvas");
const ageCanvas = document.getElementById("age-canvas");
const stayCanvas = document.getElementById("stay-canvas");
const fogCtx = fogCanvas.getContext("2d");
const ageCtx = ageCanvas.getContext("2d");
const stayCtx = stayCanvas.getContext("2d");

function resizeCanvas() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    [fogCanvas, ageCanvas, stayCanvas].forEach((canvas) => {
        canvas.width = width;
        canvas.height = height;
    });
    scheduleRender();
}

window.addEventListener("resize", resizeCanvas);
map.on("move zoom", scheduleRender);

function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        render();
    });
}

function render() {
    renderFog();
    renderAgeTint();
    renderStayTint();
}

function renderFog() {
    const width = fogCanvas.width;
    const height = fogCanvas.height;

    fogCtx.clearRect(0, 0, width, height);
    fogCtx.fillStyle = `rgba(8, 10, 18, ${FOG_ALPHA})`;
    fogCtx.fillRect(0, 0, width, height);

    if (pathCoordinates.length === 0) return;

    const now = Date.now();
    fogCtx.save();
    fogCtx.globalCompositeOperation = "destination-out";

    pathCoordinates.forEach((point, index) => {
        const elapsedMs = now - point.startTime;
        const fadeSteps = elapsedMs / FOG_FADE_INTERVAL_MS;
        const brightness = Math.max(FOG_FADE_START, 1 - fadeSteps * FOG_FADE_STEP);
        fogCtx.globalAlpha = brightness;

        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = getMetersToPixels(FOG_RADIUS_M);

        fogCtx.beginPath();
        fogCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        fogCtx.fill();

        if (index > 0) {
            const prev = map.latLngToContainerPoint([
                pathCoordinates[index - 1].lat,
                pathCoordinates[index - 1].lng
            ]);
            fogCtx.beginPath();
            fogCtx.lineWidth = radius * 1.7;
            fogCtx.lineCap = "round";
            fogCtx.lineJoin = "round";
            fogCtx.moveTo(prev.x, prev.y);
            fogCtx.lineTo(pos.x, pos.y);
            fogCtx.stroke();
        }
    });

    fogCtx.restore();
}

function renderAgeTint() {
    const width = ageCanvas.width;
    const height = ageCanvas.height;

    ageCtx.clearRect(0, 0, width, height);
    if (pathCoordinates.length === 0) return;

    const now = Date.now();

    ageCtx.save();
    ageCtx.beginPath();

    pathCoordinates.forEach((point, index) => {
        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = getMetersToPixels(FOG_RADIUS_M);

        ageCtx.moveTo(pos.x + radius, pos.y);
        ageCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);

        if (index > 0) {
            const prev = map.latLngToContainerPoint([
                pathCoordinates[index - 1].lat,
                pathCoordinates[index - 1].lng
            ]);
            const dx = pos.x - prev.x;
            const dy = pos.y - prev.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len * radius * 0.85;
            const ny = dx / len * radius * 0.85;

            ageCtx.moveTo(prev.x + nx, prev.y + ny);
            ageCtx.lineTo(pos.x + nx, pos.y + ny);
            ageCtx.lineTo(pos.x - nx, pos.y - ny);
            ageCtx.lineTo(prev.x - nx, prev.y - ny);
            ageCtx.closePath();
        }
    });

    ageCtx.clip();

    pathCoordinates.forEach((point, index) => {
        const ageDays = (now - point.startTime) / 86400000;
        const color = getAgeColor(ageDays);
        if (!color) return;

        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = getMetersToPixels(FOG_RADIUS_M);

        ageCtx.fillStyle = color;
        ageCtx.strokeStyle = color;

        ageCtx.beginPath();
        ageCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ageCtx.fill();

        if (index > 0) {
            const prev = map.latLngToContainerPoint([
                pathCoordinates[index - 1].lat,
                pathCoordinates[index - 1].lng
            ]);
            ageCtx.beginPath();
            ageCtx.lineWidth = radius * 1.15;
            ageCtx.lineCap = "round";
            ageCtx.lineJoin = "round";
            ageCtx.moveTo(prev.x, prev.y);
            ageCtx.lineTo(pos.x, pos.y);
            ageCtx.stroke();
        }
    });

    ageCtx.restore();
}

function renderStayTint() {
    const width = stayCanvas.width;
    const height = stayCanvas.height;

    stayCtx.clearRect(0, 0, width, height);
    if (pathCoordinates.length === 0) return;

    stayCtx.save();
    stayCtx.beginPath();

    pathCoordinates.forEach((point, index) => {
        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = getMetersToPixels(FOG_RADIUS_M + 2);

        stayCtx.moveTo(pos.x + radius, pos.y);
        stayCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);

        if (index > 0) {
            const prev = map.latLngToContainerPoint([
                pathCoordinates[index - 1].lat,
                pathCoordinates[index - 1].lng
            ]);
            const dx = pos.x - prev.x;
            const dy = pos.y - prev.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const nx = -dy / len * radius * 0.85;
            const ny = dx / len * radius * 0.85;

            stayCtx.moveTo(prev.x + nx, prev.y + ny);
            stayCtx.lineTo(pos.x + nx, pos.y + ny);
            stayCtx.lineTo(pos.x - nx, pos.y - ny);
            stayCtx.lineTo(prev.x - nx, prev.y - ny);
            stayCtx.closePath();
        }
    });

    stayCtx.clip();

    pathCoordinates.forEach((point) => {
        const stayMin = (point.endTime - point.startTime) / 60000;
        const color = getStayColor(stayMin);
        if (!color) return;

        const pos = map.latLngToContainerPoint([point.lat, point.lng]);
        const radius = getMetersToPixels(FOG_RADIUS_M + 2);
        const grad = stayCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);

        grad.addColorStop(0, color.center);
        grad.addColorStop(0.65, color.mid);
        grad.addColorStop(1, color.edge);

        stayCtx.beginPath();
        stayCtx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        stayCtx.fillStyle = grad;
        stayCtx.fill();
    });

    stayCtx.restore();
}

function getAgeColor(ageDays) {
    if (ageDays < 365) return null;
    if (ageDays < 365 * 3) return "rgba(150, 214, 92, 0.40)";
    if (ageDays < 365 * 5) return "rgba(214, 176, 55, 0.40)";
    return "rgba(130, 92, 55, 0.40)";
}

// ?곕몢(10遺? ???몃옉(30遺? ??二쇳솴(60遺?
function getStayColor(stayMin) {
    if (stayMin >= 10 && stayMin < 30) {
        return {
            center: "rgba(100, 230, 120, 0.75)",
            mid:    "rgba(100, 230, 120, 0.40)",
            edge:   "rgba(100, 230, 120, 0)"
        };
    }
    if (stayMin >= 30 && stayMin < 60) {
        return {
            center: "rgba(255, 210, 50, 0.80)",
            mid:    "rgba(255, 210, 50, 0.40)",
            edge:   "rgba(255, 210, 50, 0)"
        };
    }
    if (stayMin >= 60) {
        return {
            center: "rgba(255, 110, 40, 0.85)",
            mid:    "rgba(255, 110, 40, 0.45)",
            edge:   "rgba(255, 110, 40, 0)"
        };
    }
    return null;
}

function getMetersToPixels(meters) {
    const center = map.getCenter();
    const pt = map.latLngToContainerPoint(center);
    const ll2 = map.containerPointToLatLng(L.point(pt.x + 10, pt.y));
    const metersPerPixels = center.distanceTo(ll2);
    return metersPerPixels ? (meters / metersPerPixels) * 10 : 1;
}

function syncRecordingUI() {
    recBtn.classList.toggle("recording", isRecording);
    recStatusBox.textContent = isRecording ? "湲곕줉 以? : "?湲?以?;
    recStatusBox.classList.toggle("recording", isRecording);
}

function resetRecordingState() {
    isRecording = false;
    syncRecordingUI();
    stopTracking();
}

function toggleRecording() {
    if (isRecording) {
        isRecording = false;
        syncRecordingUI();
        stopTracking();
        compactPathData();
        scheduleSave();
        return;
    }
    isRecording = true;
    syncRecordingUI();
    startTracking();
}

function startTracking() {
    if (!navigator.geolocation) {
        alert("??釉뚮씪?곗????꾩튂 異붿쟻??吏?먰븯吏 ?딆뒿?덈떎.");
        resetRecordingState();
        return;
    }
    if (!window.isSecureContext &&
        location.hostname !== "localhost" &&
        location.hostname !== "127.0.0.1") {
        alert("?꾩튂 異붿쟻? HTTPS ?먮뒗 localhost?먯꽌留??숈옉?⑸땲??");
        resetRecordingState();
        return;
    }
    watchId = navigator.geolocation.watchPosition(
        handlePosition,
        handleLocationError,
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
}

function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

function handlePosition(position) {
    const accuracy = Number(position.coords.accuracy) || Infinity;
    const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
    currentPos = latlng;

    if (!playerMarker) {
        playerMarker = L.marker(latlng, {
            icon: L.divIcon({ className: "player-marker", iconSize: [18, 18] })
        }).addTo(map);
        map.setView(latlng, 16);
    } else {
        playerMarker.setLatLng(latlng);
    }

    if (!isRecording) return;

    if (accuracy > MAX_ACCURACY_M) {
        recStatusBox.textContent = `GPS ?쏀븿 (${Math.round(accuracy)}m)`;
        return;
    }

    recStatusBox.textContent = "湲곕줉 以?;

    const now = Date.now();

    if (pathCoordinates.length === 0) {
        pathCoordinates.push(createPathPoint(latlng, now));
        updateStats();
        scheduleSave();
        scheduleRender();
        return;
    }

    const last = pathCoordinates[pathCoordinates.length - 1];
    const dist = distanceToPoint(latlng, last);
    const stayThreshold = getDynamicStayThreshold(accuracy);

    if (dist <= stayThreshold) {
        last.endTime = now;
        last.visits = (last.visits || 1) + 1;
        const smoothFactor = 0.12;
        last.lat = last.lat + (latlng.lat - last.lat) * smoothFactor;
        last.lng = last.lng + (latlng.lng - last.lng) * smoothFactor;
    } else {
        totalDistance += dist;
        pathCoordinates.push(createPathPoint(latlng, now));
        if (pathCoordinates.length > MAX_PATH_POINTS) {
            compactPathData();
        }
    }

    updateStats();
    scheduleSave();
    scheduleRender();
}

function handleLocationError(err) {
    let message = "?꾩튂 ?뺣낫瑜?媛?몄삤吏 紐삵뻽?듬땲??";
    if (err.code === 1) message = "?꾩튂 沅뚰븳??嫄곕??섏뿀?듬땲??";
    if (err.code === 2) message = "?꾩옱 ?꾩튂瑜??뺤씤?????놁뒿?덈떎.";
    if (err.code === 3) message = "?꾩튂 ?붿껌 ?쒓컙??珥덇낵?섏뿀?듬땲??";
    alert(message);
    resetRecordingState();
}

function createPathPoint(latlng, timestamp) {
    return {
        lat: latlng.lat,
        lng: latlng.lng,
        startTime: timestamp,
        endTime: timestamp,
        visits: 1
    };
}

function distanceToPoint(latlng, point) {
    return latlng.distanceTo([point.lat, point.lng]);
}

function getDynamicStayThreshold(accuracy) {
    return Math.max(
        MIN_MOVE_M,
        Math.min(MAX_STAY_RADIUS_M, accuracy * STAY_ACCURACY_FACTOR)
    );
}

function compactPathData() {
    if (pathCoordinates.length <= 1) return;

    const merged = [];
    for (const point of pathCoordinates) {
        const last = merged[merged.length - 1];
        if (!last) {
            merged.push({ ...point });
            continue;
        }
        const timeGap = point.startTime - last.endTime;
        const dist = L.latLng(point.lat, point.lng).distanceTo([last.lat, last.lng]);

        if (dist <= MERGE_DISTANCE_M && timeGap <= MERGE_TIME_GAP_MS) {
            const totalVisits = (last.visits || 1) + (point.visits || 1);
            last.lat = ((last.lat * (last.visits || 1)) + (point.lat * (point.visits || 1))) / totalVisits;
            last.lng = ((last.lng * (last.visits || 1)) + (point.lng * (point.visits || 1))) / totalVisits;
            last.endTime = Math.max(last.endTime, point.endTime);
            last.visits = totalVisits;
        } else {
            merged.push({ ...point });
        }
    }

    pathCoordinates = shrinkOldPoints(merged, MAX_PATH_POINTS);
}

function shrinkOldPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const keepTail = Math.floor(maxPoints * 0.4);
    const tail = points.slice(-keepTail);
    const head = points.slice(0, points.length - keepTail);
    const ratio = Math.ceil(head.length / (maxPoints - keepTail));
    const reducedHead = head.filter((_, index) => index % ratio === 0);
    return [...reducedHead, ...tail].slice(-maxPoints);
}

function updateStats() {
    document.getElementById("dist-val").innerHTML =
        (totalDistance / 1000).toFixed(2) + "<span>km</span>";
    document.getElementById("memo-val").innerText = memories.length;
}

function addMemory() {
    if (!currentPos) {
        alert("?꾩튂 ?뺣낫瑜??섏떊 以묒엯?덈떎.");
        return;
    }
    const input = prompt("???μ냼???대쫫???낅젰?섏꽭??", "?덈줈??諛쒓껄");
    if (input === null) return;

    const now = new Date();
    const data = {
        id: String(now.getTime()),
        lat: currentPos.lat,
        lng: currentPos.lng,
        name: escapeHtml(input.trim() || "湲곗뼦??吏??),
        time: now.getTime(),
        dateString: now.toLocaleDateString("ko-KR", {
            year: "numeric",
            month: "long",
            day: "numeric"
        })
    };

    memories.push(data);
    createMemoryMarker(data, true);
    updateMemoryList();
    updateStats();
    scheduleSave();
}

function createMemoryMarker(data, openPopup = false) {
    const marker = L.marker([data.lat, data.lng], {
        icon: L.divIcon({ className: "memory-marker", html: "??, iconSize: [28, 28] })
    }).addTo(map);

    marker.bindPopup(
        "<b>" + data.name + "</b><br><small>" + data.dateString + " 湲곕줉</small><br>" +
        '<button onclick="deleteMemory(\'' + data.id + '\')" ' +
        'style="margin-top:8px;padding:6px 10px;border:none;border-radius:8px;background:#ff5555;color:#fff;cursor:pointer;">??젣</button>'
    );

    memoryMarkers.set(data.id, marker);
    if (openPopup) marker.openPopup();
}

function deleteMemory(id) {
    memories = memories.filter((memory) => memory.id !== id);
    const marker = memoryMarkers.get(id);
    if (marker) {
        map.removeLayer(marker);
        memoryMarkers.delete(id);
    }
    updateMemoryList();
    updateStats();
    scheduleSave();
}

function updateMemoryList() {
    const container = document.getElementById("memory-list-container");
    if (memories.length === 0) {
        container.innerHTML = '<p class="empty-message">?꾩쭅 湲곕줉???놁뒿?덈떎.</p>';
        return;
    }
    container.innerHTML = "";
    [...memories].reverse().forEach((memo) => {
        const item = document.createElement("div");
        item.className = "memory-item";
        item.innerHTML =
            '<span class="item-name">??' + memo.name + '</span>' +
            '<span class="item-date">' + memo.dateString + '</span>' +
            '<div style="margin-top:10px;display:flex;gap:8px;">' +
            '<button onclick="event.stopPropagation(); map.flyTo([' + memo.lat + ',' + memo.lng + '], 17);" ' +
            'style="flex:1;padding:8px;border:none;border-radius:8px;background:#4db8ff;color:#fff;cursor:pointer;">?대룞</button>' +
            '<button onclick="event.stopPropagation(); deleteMemory(\'' + memo.id + '\')" ' +
            'style="flex:1;padding:8px;border:none;border-radius:8px;background:#ff5555;color:#fff;cursor:pointer;">??젣</button>' +
            "</div>";
        item.onclick = () => {
            map.flyTo([memo.lat, memo.lng], 17);
            toggleSidebar(false);
        };
        container.appendChild(item);
    });
}

function toggleSidebar(forceOpen) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    const willOpen = typeof forceOpen === "boolean"
        ? forceOpen
        : !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", willOpen);
    overlay.classList.toggle("show", willOpen);
}

function centerMap() {
    if (currentPos) map.panTo(currentPos);
}

function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        compactPathData();
        persistState();
    }, SAVE_DELAY_MS);
}

function persistState() {
    try {
        const data = {
            pathCoordinates: pathCoordinates.map((point) => ({
                lat: point.lat,
                lng: point.lng,
                startTime: point.startTime,
                endTime: point.endTime,
                visits: point.visits || 1
            })),
            memories: memories.map((memory) => ({
                id: memory.id,
                lat: memory.lat,
                lng: memory.lng,
                name: memory.name,
                time: memory.time,
                dateString: memory.dateString
            })),
            totalDistance
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        console.error("????ㅽ뙣", error);
    }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);

        if (Array.isArray(saved.pathCoordinates)) {
            pathCoordinates = saved.pathCoordinates
                .filter((point) =>
                    isFinite(point.lat) &&
                    isFinite(point.lng) &&
                    isFinite(point.startTime) &&
                    isFinite(point.endTime)
                )
                .map((point) => ({
                    lat: point.lat,
                    lng: point.lng,
                    startTime: point.startTime,
                    endTime: point.endTime,
                    visits: isFinite(point.visits) ? point.visits : 1
                }));
        }

        if (Array.isArray(saved.memories)) {
            memories = saved.memories
                .filter((memory) =>
                    isFinite(memory.lat) &&
                    isFinite(memory.lng) &&
                    typeof memory.name === "string"
                )
                .map((memory) => ({
                    id: typeof memory.id === "string" ? memory.id : String(memory.time),
                    lat: memory.lat,
                    lng: memory.lng,
                    name: memory.name,
                    time: memory.time,
                    dateString: memory.dateString
                }));
        }

        if (isFinite(saved.totalDistance)) {
            totalDistance = saved.totalDistance;
        }

        compactPathData();
    } catch (error) {
        console.error("蹂듭썝 ?ㅽ뙣", error);
    }
}

function renderStoredMarkers() {
    memories.forEach((memory) => createMemoryMarker(memory, false));
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

loadState();
renderStoredMarkers();
updateStats();
updateMemoryList();
syncRecordingUI();
resizeCanvas();
scheduleRender();

