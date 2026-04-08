const DEFAULT_CENTER = [34.069, 134.345];
const WEATHER_SAMPLE_COUNT = 4;
const TAXI_RATE_PER_KM = 600;
const CAR_RATE_PER_KM = 30;

const map = L.map('map').setView(DEFAULT_CENTER, 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const ui = {
  searchInput: document.getElementById('destination-search'),
  searchButton: document.getElementById('search-button'),
  searchResults: document.getElementById('search-results'),
  transport: document.getElementById('transport'),
  discount: document.getElementById('kamiyama-discount'),
  statusText: document.getElementById('status-text'),
  distanceText: document.getElementById('distance-text'),
  durationText: document.getElementById('duration-text'),
  fareText: document.getElementById('fare-text'),
  fareDetail: document.getElementById('fare-detail'),
  fareComparison: document.getElementById('fare-comparison'),
  weatherList: document.getElementById('weather-list'),
};

const state = {
  currentLocation: null,
  destination: null,
  routeDistanceKm: null,
  routeDurationMin: null,
};

let currentMarker;
let destinationMarker;
let routeLayer;
let weatherLayer = L.layerGroup().addTo(map);

function setStatus(message) {
  ui.statusText.textContent = message;
}

function formatYen(value) {
  return `${Math.round(value).toLocaleString('ja-JP')} 円`;
}

function getBusFare(distanceKm) {
  if (distanceKm <= 3) return 210;
  if (distanceKm <= 8) return 320;
  if (distanceKm <= 15) return 530;
  if (distanceKm <= 25) return 760;
  if (distanceKm <= 40) return 980;
  return 980 + Math.round((distanceKm - 40) * 18);
}

function getTrainFare(distanceKm) {
  if (distanceKm <= 3) return 150;
  if (distanceKm <= 6) return 190;
  if (distanceKm <= 10) return 240;
  if (distanceKm <= 20) return 420;
  if (distanceKm <= 35) return 680;
  return 680 + Math.round((distanceKm - 35) * 16);
}

function getAllFares(distanceKm) {
  const taxiBase = distanceKm * TAXI_RATE_PER_KM;
  const taxiFare = ui.discount.checked ? taxiBase * 0.15 : taxiBase;
  return {
    taxi: {
      value: taxiFare,
      detail: ui.discount.checked
        ? `通常料金 ${formatYen(taxiBase)} に神山町民割引(85%OFF)適用`
        : `通常料金 ${formatYen(taxiBase)}（割引なし）`,
    },
    car: {
      value: distanceKm * CAR_RATE_PER_KM,
      detail: `距離 ${distanceKm.toFixed(1)}km × ${CAR_RATE_PER_KM}円/km`,
    },
    bus: {
      value: getBusFare(distanceKm),
      detail: '徳島県内想定の簡易距離料金表',
    },
    train: {
      value: getTrainFare(distanceKm),
      detail: '徳島県内想定の簡易距離料金表',
    },
  };
}

function updateFareDisplay() {
  if (!state.routeDistanceKm) {
    ui.fareText.textContent = '-';
    ui.fareDetail.textContent = '';
    ui.fareComparison.innerHTML = '';
    return;
  }

  const fares = getAllFares(state.routeDistanceKm);
  const selected = ui.transport.value;
  ui.fareText.textContent = formatYen(fares[selected].value);
  ui.fareDetail.textContent = fares[selected].detail;

  ui.fareComparison.innerHTML = '';
  const labels = { taxi: 'タクシー', car: '車', bus: 'バス', train: '電車' };
  Object.entries(fares).forEach(([key, data]) => {
    const row = document.createElement('div');
    row.className = `comparison-item ${selected === key ? 'active' : ''}`;
    row.innerHTML = `<span>${labels[key]}</span><span>${formatYen(data.value)}</span>`;
    ui.fareComparison.appendChild(row);
  });
}

function weatherCodeToText(code) {
  const table = {
    0: '快晴', 1: '晴れ', 2: '晴れ時々曇り', 3: '曇り',
    45: '霧', 48: '着氷性の霧',
    51: '弱い霧雨', 53: '霧雨', 55: '強い霧雨',
    61: '弱い雨', 63: '雨', 65: '強い雨',
    71: '弱い雪', 73: '雪', 75: '強い雪',
    80: 'にわか雨', 81: '強いにわか雨', 82: '激しいにわか雨',
    95: '雷雨',
  };
  return table[code] ?? '不明';
}

async function fetchWeather(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('current', 'temperature_2m,weather_code,rain');
  url.searchParams.set('hourly', 'precipitation_probability');
  url.searchParams.set('forecast_hours', '1');
  url.searchParams.set('timezone', 'auto');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('天気情報の取得に失敗しました。');
  const data = await res.json();
  return {
    weather: weatherCodeToText(data.current.weather_code),
    temp: data.current.temperature_2m,
    rain: data.current.rain,
    precipitationProb: data?.hourly?.precipitation_probability?.[0],
  };
}

function toRad(v) {
  return (v * Math.PI) / 180;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolatePoint(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

function sampleRoutePointsByDistance(routeCoords, sampleCount) {
  if (routeCoords.length === 0) return [];

  const points = routeCoords.map(([lon, lat]) => ({ lat, lon }));
  let totalDistance = 0;
  const segmentLengths = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const seg = distanceMeters(points[i], points[i + 1]);
    segmentLengths.push(seg);
    totalDistance += seg;
  }

  const sampled = [];
  for (let i = 1; i <= sampleCount; i += 1) {
    const target = (totalDistance * i) / (sampleCount + 1);
    let accumulated = 0;

    for (let s = 0; s < segmentLengths.length; s += 1) {
      if (accumulated + segmentLengths[s] >= target) {
        const remain = target - accumulated;
        const ratio = segmentLengths[s] === 0 ? 0 : remain / segmentLengths[s];
        const point = interpolatePoint(points[s], points[s + 1], ratio);
        sampled.push({ ...point, label: `道中地点 ${i}` });
        break;
      }
      accumulated += segmentLengths[s];
    }
  }

  const destination = points[points.length - 1];
  sampled.push({ ...destination, label: '目的地' });
  return sampled;
}

async function renderWeather(points) {
  ui.weatherList.innerHTML = '<p>天気情報を取得しています...</p>';
  weatherLayer.clearLayers();

  const weatherEntries = await Promise.all(
    points.map(async (point) => {
      try {
        const weather = await fetchWeather(point.lat, point.lon);
        return { ...point, ...weather };
      } catch (error) {
        return { ...point, error: error.message };
      }
    })
  );

  ui.weatherList.innerHTML = '';
  weatherEntries.forEach((entry, index) => {
    const marker = L.circleMarker([entry.lat, entry.lon], {
      radius: 7,
      color: entry.label === '目的地' ? '#d13b3b' : '#1f6feb',
      fillOpacity: 0.9,
    }).addTo(weatherLayer);

    const item = document.createElement('article');
    item.className = 'weather-item';

    if (entry.error) {
      marker.bindPopup(`${entry.label}<br>${entry.error}`);
      item.innerHTML = `<h3>${index + 1}. ${entry.label}</h3><p>${entry.error}</p>`;
      ui.weatherList.appendChild(item);
      return;
    }

    const rainText = entry.rain > 0 ? `降雨あり (${entry.rain}mm)` : '降雨なし';
    const probText =
      typeof entry.precipitationProb === 'number'
        ? `降水確率: ${entry.precipitationProb}%`
        : '降水確率: 取得不可';

    marker.bindPopup(`${entry.label}<br>${entry.weather}<br>${entry.temp}°C<br>${rainText}<br>${probText}`);
    item.innerHTML = `
      <h3>${index + 1}. ${entry.label}</h3>
      <p>天候: ${entry.weather}</p>
      <p>気温: ${entry.temp} °C</p>
      <p>${probText}</p>
      <p>${rainText}</p>
    `;
    ui.weatherList.appendChild(item);
  });
}

async function fetchRoute(origin, destination) {
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}`
  );
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('ルート取得に失敗しました。');
  const data = await res.json();
  if (!data.routes?.length) throw new Error('ルートが見つかりませんでした。');
  return data.routes[0];
}

async function rebuildRouteAndInfo() {
  if (!state.currentLocation || !state.destination) return;

  try {
    setStatus('ルートを計算しています...');
    const route = await fetchRoute(state.currentLocation, state.destination);
    const routeLatLng = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);

    if (routeLayer) routeLayer.remove();
    routeLayer = L.polyline(routeLatLng, { color: '#2274ff', weight: 5 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });

    state.routeDistanceKm = route.distance / 1000;
    state.routeDurationMin = route.duration / 60;
    ui.distanceText.textContent = `距離: ${state.routeDistanceKm.toFixed(2)} km`;
    ui.durationText.textContent = `所要時間(目安): ${Math.round(state.routeDurationMin)} 分`;

    updateFareDisplay();
    const points = sampleRoutePointsByDistance(route.geometry.coordinates, WEATHER_SAMPLE_COUNT);
    await renderWeather(points);
    setStatus('ルート・天気・料金を更新しました。');
  } catch (error) {
    setStatus(error.message);
  }
}

function setCurrentLocation(lat, lon) {
  state.currentLocation = { lat, lon };
  if (currentMarker) currentMarker.remove();
  currentMarker = L.marker([lat, lon]).addTo(map).bindPopup('現在地');
}

function setDestination(lat, lon, name = '選択した目的地') {
  state.destination = { lat, lon, name };
  if (destinationMarker) destinationMarker.remove();
  destinationMarker = L.marker([lat, lon]).addTo(map).bindPopup(`目的地: ${name}`);
  destinationMarker.openPopup();
  setStatus(`目的地を設定しました: ${name}`);
  rebuildRouteAndInfo();
}

async function searchDestination() {
  const q = ui.searchInput.value.trim();
  if (!q) return;

  ui.searchResults.innerHTML = '<li><button type="button">検索中...</button></li>';
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '5');
  url.searchParams.set('accept-language', 'ja');

  try {
    const res = await fetch(url.toString(), { headers: { 'Accept-Language': 'ja' } });
    if (!res.ok) throw new Error('地点検索に失敗しました。');
    const results = await res.json();

    ui.searchResults.innerHTML = '';
    if (!results.length) {
      ui.searchResults.innerHTML = '<li><button type="button">候補が見つかりませんでした。</button></li>';
      return;
    }

    results.forEach((place) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.display_name;
      button.addEventListener('click', () => {
        setDestination(Number(place.lat), Number(place.lon), place.display_name);
        ui.searchResults.innerHTML = '';
      });
      li.appendChild(button);
      ui.searchResults.appendChild(li);
    });
  } catch (error) {
    ui.searchResults.innerHTML = `<li><button type="button">${error.message}</button></li>`;
  }
}

function setupEventListeners() {
  ui.searchButton.addEventListener('click', searchDestination);
  ui.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') searchDestination();
  });
  ui.transport.addEventListener('change', updateFareDisplay);
  ui.discount.addEventListener('change', updateFareDisplay);

  map.on('click', (event) => {
    setDestination(event.latlng.lat, event.latlng.lng, '地図で選択した地点');
  });
}

function initCurrentLocation() {
  if (!navigator.geolocation) {
    setStatus('このブラウザは位置情報取得に対応していません。');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setCurrentLocation(coords.latitude, coords.longitude);
      map.setView([coords.latitude, coords.longitude], 13);
      currentMarker.openPopup();
      setStatus('現在地を取得しました。目的地を選択してください。');
    },
    () => {
      setCurrentLocation(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
      map.setView(DEFAULT_CENTER, 12);
      setStatus('現在地取得に失敗したため、神山町を初期位置として表示しています。');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

setupEventListeners();
initCurrentLocation();
