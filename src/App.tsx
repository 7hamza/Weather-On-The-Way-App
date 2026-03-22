import { useEffect, useMemo, useState } from 'react'
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import type { DivIcon } from 'leaflet'
import L, { LatLngBounds, type LatLngTuple } from 'leaflet'
import { addDays, format, isAfter, parseISO } from 'date-fns'
import './App.css'

type Waypoint = {
  name: string
  lat: number
  lon: number
}

type RouteStop = {
  id: number
  kind: 'origin' | 'via' | 'destination'
  input: string
  waypoint: Waypoint | null
}

type WeatherSample = {
  id: number
  lat: number
  lon: number
  locationName: string
  routeKm: number
  isDay: boolean
  etaIso: string
  tempC: number
  precipProb: number
  windKph: number
  code: number
}

type OsrmRoute = {
  distance: number
  duration: number
  geometry: {
    coordinates: [number, number][]
  }
  legs: Array<{
    annotation?: {
      duration?: number[]
      distance?: number[]
    }
  }>
}

type GeocodingResult = {
  id?: number
  name?: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
  admin2?: string
}

type GeocodingResponse = {
  results?: GeocodingResult[]
}

L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const MAX_FORECAST_DAYS = 16
const MIN_WEATHER_POINTS = 6
const MAX_WEATHER_POINTS = 20

const weatherCodeText: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Slight rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Slight snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
}

function createStop(kind: RouteStop['kind']): RouteStop {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000000),
    kind,
    input: '',
    waypoint: null,
  }
}

function initialStops(): RouteStop[] {
  return [createStop('origin'), createStop('destination')]
}

function routePointsFromCoordinates(coordinates: [number, number][]): LatLngTuple[] {
  return coordinates.map(([lon, lat]) => [lat, lon])
}

function toDateInputValue(d: Date): string {
  return format(d, "yyyy-MM-dd'T'HH:mm")
}

function nearestTimeIndex(times: string[], target: Date): number {
  const targetMs = target.getTime()
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY

  times.forEach((entry, idx) => {
    const diff = Math.abs(new Date(entry).getTime() - targetMs)
    if (diff < bestDistance) {
      bestDistance = diff
      bestIndex = idx
    }
  })

  return bestIndex
}

function estimateEtasFallback(
  points: LatLngTuple[],
  startDate: Date,
  totalDurationSec: number,
  totalDistanceM: number,
  sampleCount: number,
): Array<{ lat: number; lon: number; eta: Date; routeKm: number }> {
  if (points.length === 0 || sampleCount <= 0) {
    return []
  }

  const samples: Array<{ lat: number; lon: number; eta: Date; routeKm: number }> = []
  const steps = Math.max(sampleCount - 1, 1)

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = i / steps
    const pointIndex = Math.min(Math.round(ratio * (points.length - 1)), points.length - 1)
    const [lat, lon] = points[pointIndex]
    const eta = new Date(startDate.getTime() + totalDurationSec * 1000 * ratio)
    samples.push({ lat, lon, eta, routeKm: (totalDistanceM * ratio) / 1000 })
  }

  return samples
}

function estimateEtasFromSegments(
  points: LatLngTuple[],
  startDate: Date,
  segmentDurations: number[],
  segmentDistances: number[],
  sampleCount: number,
): Array<{ lat: number; lon: number; eta: Date; routeKm: number }> {
  if (points.length < 2 || sampleCount <= 0) {
    return []
  }

  const segmentCount = Math.min(
    points.length - 1,
    segmentDurations.length,
    segmentDistances.length,
  )

  if (segmentCount <= 0) {
    return []
  }

  const totalDurationSec = segmentDurations
    .slice(0, segmentCount)
    .reduce((sum, value) => sum + Math.max(0, value), 0)

  if (totalDurationSec <= 0) {
    return []
  }

  const samples: Array<{ lat: number; lon: number; eta: Date; routeKm: number }> = []
  const steps = Math.max(sampleCount - 1, 1)

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = i / steps
    const targetElapsedSec = totalDurationSec * ratio

    let elapsedSec = 0
    let distanceM = 0
    let selectedSegment = 0

    for (let segmentIdx = 0; segmentIdx < segmentCount; segmentIdx += 1) {
      const segmentDuration = Math.max(0, segmentDurations[segmentIdx])
      if (elapsedSec + segmentDuration >= targetElapsedSec || segmentIdx === segmentCount - 1) {
        selectedSegment = segmentIdx
        break
      }
      elapsedSec += segmentDuration
      distanceM += Math.max(0, segmentDistances[segmentIdx])
    }

    const segmentDuration = Math.max(0, segmentDurations[selectedSegment])
    const segmentDistance = Math.max(0, segmentDistances[selectedSegment])
    const segmentElapsed = targetElapsedSec - elapsedSec
    const segmentRatio = segmentDuration > 0 ? Math.max(0, Math.min(1, segmentElapsed / segmentDuration)) : 0

    const [fromLat, fromLon] = points[selectedSegment]
    const [toLat, toLon] = points[Math.min(selectedSegment + 1, points.length - 1)]
    const lat = fromLat + (toLat - fromLat) * segmentRatio
    const lon = fromLon + (toLon - fromLon) * segmentRatio
    const eta = new Date(startDate.getTime() + targetElapsedSec * 1000)

    samples.push({
      lat,
      lon,
      eta,
      routeKm: (distanceM + segmentDistance * segmentRatio) / 1000,
    })
  }

  return samples
}

function distanceLabel(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`
}

function durationLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function stopSymbol(kind: RouteStop['kind'], index: number): string {
  if (kind !== 'via') {
    return ''
  }
  return `${index}`
}

function createStopIcon(kind: RouteStop['kind'], index: number): DivIcon {
  const inside =
    kind === 'via'
      ? stopSymbol(kind, index)
      : `<span class="badge-glyph ${kind}" aria-hidden="true"></span>`

  return L.divIcon({
    className: 'waypoint-pin-wrap',
    html: `<div class="waypoint-pin ${kind}">${inside}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

function placeLabelFromReverse(result: GeocodingResult | null): string | null {
  if (!result) {
    return null
  }

  return result.name ?? result.admin2 ?? result.admin1 ?? result.country ?? null
}

function weatherIconMeta(code: number, isDay: boolean): { emoji: string; kind: string } {
  if (code === 0 || code === 1) {
    return isDay ? { emoji: '☀️', kind: 'clear' } : { emoji: '🌙', kind: 'clear' }
  }
  if (code === 2 || code === 3) {
    return isDay ? { emoji: '⛅', kind: 'cloud' } : { emoji: '☁️', kind: 'cloud' }
  }
  if (code === 45 || code === 48) {
    return { emoji: '🌫️', kind: 'fog' }
  }
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return { emoji: '🌧️', kind: 'rain' }
  }
  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return { emoji: '❄️', kind: 'snow' }
  }
  if ([95, 96, 99].includes(code)) {
    return { emoji: '⛈️', kind: 'storm' }
  }
  return { emoji: '🌤️', kind: 'cloud' }
}

function createWeatherIconWithTemp(code: number, isDay: boolean, tempC: number): DivIcon {
  const meta = weatherIconMeta(code, isDay)
  const roundedTemp = Math.round(tempC)
  return L.divIcon({
    className: 'weather-pin-wrap',
    html: `<div class="weather-pin ${meta.kind} ${isDay ? 'day' : 'night'}"><span class="weather-emoji">${meta.emoji}</span><span class="weather-temp-badge">${roundedTemp}°</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

function timezoneToPlaceLabel(timezone?: string): string | null {
  if (!timezone) {
    return null
  }

  const lastPart = timezone.split('/').pop()
  if (!lastPart) {
    return null
  }

  return lastPart.replace(/_/g, ' ')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function MapClickCapture({
  enabled,
  onPickLocation,
}: {
  enabled: boolean
  onPickLocation: (lat: number, lon: number) => void
}) {
  useMapEvents({
    click(event) {
      if (!enabled) {
        return
      }
      onPickLocation(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

function FitToRoute({ points }: { points: LatLngTuple[] }) {
  const map = useMap()

  if (points.length >= 2) {
    const bounds = new LatLngBounds(points)
    map.fitBounds(bounds, { padding: [40, 40] })
  }

  return null
}

function App() {
  const [stops, setStops] = useState<RouteStop[]>(initialStops())
  const [activeStopId, setActiveStopId] = useState<number | null>(null)
  const [searchResults, setSearchResults] = useState<GeocodingResult[]>([])
  const [isSearching, setIsSearching] = useState(false)

  const [tripStart, setTripStart] = useState<string>(
    toDateInputValue(new Date(Date.now() + 2 * 60 * 60 * 1000)),
  )
  const [tripTimeMode, setTripTimeMode] = useState<'depart' | 'arrive'>('depart')
  const [weatherPointCount, setWeatherPointCount] = useState<number>(12)
  const [routePoints, setRoutePoints] = useState<LatLngTuple[]>([])
  const [routeDistanceM, setRouteDistanceM] = useState<number>(0)
  const [routeDurationS, setRouteDurationS] = useState<number>(0)
  const [routeSegmentDurations, setRouteSegmentDurations] = useState<number[]>([])
  const [routeSegmentDistances, setRouteSegmentDistances] = useState<number[]>([])
  const [weatherSamples, setWeatherSamples] = useState<WeatherSample[]>([])
  const [isRouting, setIsRouting] = useState(false)
  const [, setIsWeatherLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const tooFarInFuture = useMemo(() => {
    const selected = parseISO(tripStart)
    return isAfter(selected, addDays(new Date(), MAX_FORECAST_DAYS))
  }, [tripStart])

  const activeStop = useMemo(
    () => stops.find((stop) => stop.id === activeStopId) ?? null,
    [stops, activeStopId],
  )

  const hasTripData = useMemo(() => {
    const hasStopValues = stops.some((stop) => stop.input.trim().length > 0 || stop.waypoint !== null)
    return hasStopValues || routePoints.length > 0 || weatherSamples.length > 0
  }, [stops, routePoints.length, weatherSamples.length])

  const resolvedStops = useMemo(
    () => stops.filter((stop): stop is RouteStop & { waypoint: Waypoint } => stop.waypoint !== null),
    [stops],
  )

  const setStopInput = (id: number, input: string) => {
    setStops((prev) =>
      prev.map((stop) => (stop.id === id ? { ...stop, input, waypoint: null } : stop)),
    )
  }

  const applyStopWaypoint = (id: number, waypoint: Waypoint) => {
    setStops((prev) =>
      prev.map((stop) =>
        stop.id === id
          ? {
              ...stop,
              input: waypoint.name,
              waypoint,
            }
          : stop,
      ),
    )
  }

  const addViaStop = () => {
    setStops((prev) => {
      const destination = prev[prev.length - 1]
      const beforeDestination = prev.slice(0, -1)
      return [...beforeDestination, createStop('via'), destination]
    })
  }

  const removeStop = (id: number) => {
    setStops((prev) => {
      const target = prev.find((stop) => stop.id === id)
      if (!target || target.kind !== 'via') {
        return prev
      }
      return prev.filter((stop) => stop.id !== id)
    })

    if (activeStopId === id) {
      setActiveStopId(null)
      setSearchResults([])
    }
  }

  const moveStop = (id: number, direction: -1 | 1) => {
    setStops((prev) => {
      const index = prev.findIndex((stop) => stop.id === id)
      const target = prev[index]
      if (index < 0 || !target || target.kind !== 'via') {
        return prev
      }

      const nextIndex = index + direction
      if (nextIndex <= 0 || nextIndex >= prev.length - 1) {
        return prev
      }

      const updated = [...prev]
      const [picked] = updated.splice(index, 1)
      updated.splice(nextIndex, 0, picked)
      return updated
    })
  }

  const clearTrip = () => {
    setStops(initialStops())
    setActiveStopId(null)
    setSearchResults([])
    setRoutePoints([])
    setWeatherSamples([])
    setRouteDistanceM(0)
    setRouteDurationS(0)
    setRouteSegmentDurations([])
    setRouteSegmentDistances([])
    setError('')
  }

  const searchLocation = async (query: string) => {
    const q = query.trim()
    if (q.length < 3) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    setError('')

    try {
      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=7&language=en&format=json`,
      )

      if (!response.ok) {
        throw new Error('Location search failed. Please try again.')
      }

      const payload: GeocodingResponse = await response.json()
      setSearchResults(payload.results ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Location search failed.'
      setError(message)
    } finally {
      setIsSearching(false)
    }
  }

  const applyPlaceToActiveStop = (place: GeocodingResult) => {
    if (!activeStopId) {
      return
    }

    const lat = place.latitude
    const lon = place.longitude
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      setError('Selected location had invalid coordinates.')
      return
    }

    const shortName = [place.name, place.admin1, place.country].filter(Boolean).join(', ')
    applyStopWaypoint(activeStopId, {
      name: shortName || `Pinned ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat,
      lon,
    })
    setSearchResults([])
  }

  const assignMapPickToActiveStop = (lat: number, lon: number) => {
    if (!activeStopId) {
      return
    }

    applyStopWaypoint(activeStopId, {
      name: `Pinned ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat,
      lon,
    })
    setSearchResults([])
  }

  useEffect(() => {
    const q = activeStop?.input.trim() ?? ''
    if (activeStopId === null || q.length < 3) {
      setSearchResults([])
      return
    }

    const timeout = setTimeout(() => {
      void searchLocation(q)
    }, 450)

    return () => clearTimeout(timeout)
  }, [activeStop?.input, activeStopId])

  const loadWeatherAlongRoute = async (
    pointsArg?: LatLngTuple[],
    durationArg?: number,
    distanceArg?: number,
    segmentDurationsArg?: number[],
    segmentDistancesArg?: number[],
    clearPrevError = true,
  ) => {
    const points = pointsArg ?? routePoints
    const duration = durationArg ?? routeDurationS
    const distance = distanceArg ?? routeDistanceM
    const segmentDurations = segmentDurationsArg ?? routeSegmentDurations
    const segmentDistances = segmentDistancesArg ?? routeSegmentDistances

    if (points.length < 2 || duration <= 0) {
      setError('Build the route first, then load weather for your trip.')
      return
    }

    if (tooFarInFuture) {
      setError(`Forecast is currently limited to ${MAX_FORECAST_DAYS} days ahead.`)
      return
    }

    if (clearPrevError) {
      setError('')
    }
    setIsWeatherLoading(true)

    try {
      const selectedTripDate = parseISO(tripStart)
      const startDate =
        tripTimeMode === 'arrive'
          ? new Date(selectedTripDate.getTime() - duration * 1000)
          : selectedTripDate
      const sampleTargetsFromSegments = estimateEtasFromSegments(
        points,
        startDate,
        segmentDurations,
        segmentDistances,
        weatherPointCount,
      )
      const sampleTargets =
        sampleTargetsFromSegments.length > 0
          ? sampleTargetsFromSegments
          : estimateEtasFallback(points, startDate, duration, distance, weatherPointCount)

      const samples: WeatherSample[] = []
      let failedCount = 0
      const geocodeCache = new Map<string, string | null>()

      const getNearestPlaceName = async (lat: number, lon: number): Promise<string | null> => {
        const key = `${lat.toFixed(3)},${lon.toFixed(3)}`
        const cached = geocodeCache.get(key)
        if (cached !== undefined) {
          return cached
        }

        const url = `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}&language=en&format=json`

        try {
          const response = await fetch(url)
          if (!response.ok) {
            geocodeCache.set(key, null)
            return null
          }

          const payload: GeocodingResponse = await response.json()
          const label = placeLabelFromReverse(payload.results?.[0] ?? null)
          geocodeCache.set(key, label)
          return label
        } catch {
          geocodeCache.set(key, null)
          return null
        }
      }

      const fetchOneSample = async (
        target: { lat: number; lon: number; eta: Date; routeKm: number },
        idx: number,
      ): Promise<WeatherSample> => {
        const reversePlaceName = await getNearestPlaceName(target.lat, target.lon)
        const date = format(target.eta, 'yyyy-MM-dd')
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${target.lat}&longitude=${target.lon}&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,is_day&timezone=auto&start_date=${date}&end_date=${date}`

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const response = await fetch(url)

          if (!response.ok) {
            if (attempt < 2) {
              continue
            }
            throw new Error(`Weather request failed with status ${response.status}.`)
          }

          const payload: {
            hourly?: {
              time?: string[]
              temperature_2m?: number[]
              precipitation_probability?: number[]
              weather_code?: number[]
              wind_speed_10m?: number[]
              is_day?: number[]
            }
          } = await response.json()

          const times = payload.hourly?.time ?? []
          const temperatures = payload.hourly?.temperature_2m ?? []
          const precipitation = payload.hourly?.precipitation_probability ?? []
          const weatherCodes = payload.hourly?.weather_code ?? []
          const windSpeeds = payload.hourly?.wind_speed_10m ?? []
          const dayFlags = payload.hourly?.is_day ?? []
          const timezoneLabel = timezoneToPlaceLabel((payload as { timezone?: string }).timezone)

          if (times.length === 0) {
            if (attempt < 2) {
              continue
            }
            throw new Error('Weather service returned empty hourly data.')
          }

          const nearestIdx = nearestTimeIndex(times, target.eta)

          return {
            id: idx,
            lat: target.lat,
            lon: target.lon,
            locationName:
              reversePlaceName ?? timezoneLabel ?? `${target.lat.toFixed(4)}, ${target.lon.toFixed(4)}`,
            routeKm: target.routeKm,
            isDay: (dayFlags[nearestIdx] ?? 1) === 1,
            etaIso: times[nearestIdx],
            tempC: temperatures[nearestIdx] ?? 0,
            precipProb: precipitation[nearestIdx] ?? 0,
            windKph: windSpeeds[nearestIdx] ?? 0,
            code: weatherCodes[nearestIdx] ?? 0,
          }
        }

        throw new Error('Weather service request failed.')
      }

      for (let idx = 0; idx < sampleTargets.length; idx += 1) {
        try {
          const sample = await fetchOneSample(sampleTargets[idx], idx)
          samples.push(sample)
        } catch {
          failedCount += 1
        }
      }

      setWeatherSamples(samples)

      if (samples.length === 0) {
        setError('Weather service is temporarily unavailable for this route. Please try again.')
      } else if (failedCount > 0) {
        setError(`Loaded ${samples.length}/${sampleTargets.length} weather checkpoints. Some points failed to load.`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load weather.'
      setError(message)
    } finally {
      setIsWeatherLoading(false)
    }
  }

  const buildRoute = async (isAuto = false) => {
    const unresolved = stops.filter((stop) => stop.waypoint === null)
    if (unresolved.length > 0) {
      if (!isAuto) {
        setError('Select a location for every stop (origin, stops, and destination) before building the route.')
      }
      return
    }

    const routeStops = stops.map((stop) => stop.waypoint as Waypoint)
    setError('')
    setIsRouting(true)

    try {
      const path = routeStops.map((w) => `${w.lon},${w.lat}`).join(';')
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson&annotations=duration,distance`,
      )

      if (!response.ok) {
        throw new Error('Routing service did not respond successfully.')
      }

      const payload: { routes: OsrmRoute[] } = await response.json()
      const firstRoute = payload.routes[0]
      if (!firstRoute) {
        throw new Error('No route available for the selected waypoints.')
      }

      const nextRoutePoints = routePointsFromCoordinates(firstRoute.geometry.coordinates)
      const segmentDurations = firstRoute.legs.flatMap((leg) => leg.annotation?.duration ?? [])
      const segmentDistances = firstRoute.legs.flatMap((leg) => leg.annotation?.distance ?? [])
      setRouteDistanceM(firstRoute.distance)
      setRouteDurationS(firstRoute.duration)
      setRouteSegmentDurations(segmentDurations)
      setRouteSegmentDistances(segmentDistances)
      setRoutePoints(nextRoutePoints)
      setWeatherSamples([])
      await loadWeatherAlongRoute(
        nextRoutePoints,
        firstRoute.duration,
        firstRoute.distance,
        segmentDurations,
        segmentDistances,
        false,
      )
      if (!tooFarInFuture) {
        setError('')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build route.'
      setError(message)
    } finally {
      setIsRouting(false)
    }
  }

  const exportItinerary = () => {
    if (!hasTripData) {
      return
    }

    const exportTime = new Date().toISOString()
    const resolved = stops
      .map((stop, idx) => ({ stop, idx }))
      .filter((entry): entry is { stop: RouteStop & { waypoint: Waypoint }; idx: number } => entry.stop.waypoint !== null)

    const waypointXml = resolved
      .map(({ stop, idx }) => {
        const kindLabel =
          stop.kind === 'origin' ? 'Start' : stop.kind === 'destination' ? 'Destination' : `Stop ${idx}`
        const name = escapeXml(`${kindLabel}: ${stop.waypoint.name}`)
        return `<wpt lat="${stop.waypoint.lat}" lon="${stop.waypoint.lon}"><name>${name}</name></wpt>`
      })
      .join('')

    const routePointXml = routePoints
      .map(([lat, lon]) => `<rtept lat="${lat}" lon="${lon}" />`)
      .join('')

    const trackPointXml = routePoints
      .map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}" />`)
      .join('')

    const routeName = escapeXml(`RouteApp ride (${tripTimeMode} ${tripStart})`)

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RouteApp" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${routeName}</name>
    <time>${exportTime}</time>
  </metadata>
  ${waypointXml}
  <rte>
    <name>${routeName}</name>
    ${routePointXml}
  </rte>
  <trk>
    <name>${routeName}</name>
    <trkseg>
      ${trackPointXml}
    </trkseg>
  </trk>
</gpx>`

    const blob = new Blob([gpx], {
      type: 'application/gpx+xml;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `routeapp-itinerary-${format(new Date(), 'yyyyMMdd-HHmm')}.gpx`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // buildRoute is intentionally not in deps to avoid recreating and retriggering this effect every render.
  useEffect(() => {
    if (stops.length < 2 || stops.some((stop) => stop.waypoint === null)) {
      return
    }

    const timeout = setTimeout(() => {
      void buildRoute(true)
    }, 500)

    return () => clearTimeout(timeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, tripStart, tripTimeMode, weatherPointCount])

  useEffect(() => {
    const existingScript = document.querySelector(
      'script[data-kofi-overlay="true"]',
    ) as HTMLScriptElement | null

    const applyKofiClasses = () => {
      const textTargets = Array.from(
        document.querySelectorAll<HTMLElement>('a, button, div, span'),
      ).filter((el) => (el.textContent ?? '').trim().toLowerCase() === 'support me')

      const launcher = textTargets[0]
      if (!launcher) {
        return false
      }

      launcher.classList.add('kofi-support-button', 'kofi-jiggle')

      let root: HTMLElement | null = launcher
      let hops = 0
      while (root && hops < 7) {
        const style = window.getComputedStyle(root)
        const idOrClass = `${root.id} ${root.className}`.toLowerCase()
        const looksLikeKofi = idOrClass.includes('kofi') || idOrClass.includes('ko-fi')
        if (looksLikeKofi || style.position === 'fixed' || style.bottom !== 'auto') {
          root.classList.add('kofi-launcher-root')
          return true
        }
        root = root.parentElement
        hops += 1
      }

      launcher.classList.add('kofi-launcher-root')
      return true
    }

    const scheduleApply = () => {
      let tries = 0
      const intervalId = window.setInterval(() => {
        tries += 1
        const done = applyKofiClasses()
        if (done || tries > 12) {
          window.clearInterval(intervalId)
        }
      }, 350)
    }

    const drawWidget = () => {
      const kofiWindow = window as Window & {
        kofiWidgetOverlay?: {
          draw: (username: string, options: Record<string, string>) => void
        }
      }

      kofiWindow.kofiWidgetOverlay?.draw('7amzags', {
        type: 'floating-chat',
        'floating-chat.position': 'right',
        'floating-chat.donateButton.text': 'Support me',
        'floating-chat.donateButton.background-color': '#323842',
        'floating-chat.donateButton.text-color': '#fff',
      })
      scheduleApply()
    }

    if (existingScript) {
      const kofiWindow = window as Window & {
        kofiWidgetOverlay?: {
          draw: (username: string, options: Record<string, string>) => void
        }
      }
      if (kofiWindow.kofiWidgetOverlay && !applyKofiClasses()) {
        drawWidget()
      } else {
        scheduleApply()
      }
      return
    }

    const script = document.createElement('script')
    script.src = 'https://storage.ko-fi.com/cdn/scripts/overlay-widget.js'
    script.async = true
    script.dataset.kofiOverlay = 'true'
    script.onload = drawWidget
    document.body.appendChild(script)
  }, [])

  return (
    <main className="app-shell">
      <aside className="panel">
        <header>
          <p className="kicker">
            <img className="brand-icon" src="/favicon.svg" alt="RouteApp icon" />
            <span>RouteApp</span>
          </p>
          <h1>Free Weather On The Way App</h1>
          <p className="subtitle">Interactive motorcycle itinerary builder with free weather forecasts along your route.</p>
          <p className="creator-note">
            Made by 7amzaGS. Watch the Amsterdam to Morocco motorcycle trip video on{' '}
            <a
              className="youtube-link"
              href="https://youtu.be/8COzowbzDFo?si=Xb4EdsNu2cclIAMs"
              target="_blank"
              rel="noreferrer"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M23.5 6.2c-.3-1.1-1.1-1.9-2.2-2.2C19.4 3.5 12 3.5 12 3.5s-7.4 0-9.3.5C1.6 4.3.8 5.1.5 6.2 0 8.1 0 12 0 12s0 3.9.5 5.8c.3 1.1 1.1 1.9 2.2 2.2 1.9.5 9.3.5 9.3.5s7.4 0 9.3-.5c1.1-.3 1.9-1.1 2.2-2.2.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zM9.6 15.6V8.4L15.8 12 9.6 15.6z" />
              </svg>
              YouTube
            </a>
            .
          </p>
        </header>

        <section className="card directions-card">
          <div className="directions-head row between">
            <h2>Directions</h2>
          </div>

          <div className="directions-list">
            {stops.map((stop, idx) => {
              const isActive = activeStopId === stop.id
              const canMoveUp = stop.kind === 'via' && idx > 1
              const canMoveDown = stop.kind === 'via' && idx < stops.length - 2

              return (
                <div key={stop.id} className={`stop-row ${isActive ? 'active' : ''}`}>
                  <span className={`stop-badge ${stop.kind}`}>
                    {stop.kind === 'via' ? stopSymbol(stop.kind, idx) : <span className={`badge-glyph ${stop.kind}`} />}
                  </span>
                  <div className="stop-input-stack">
                    <input
                      type="text"
                      value={stop.input}
                      onFocus={() => setActiveStopId(stop.id)}
                      onBlur={() => {
                        setTimeout(() => {
                          setActiveStopId((prev) => (prev === stop.id ? null : prev))
                        }, 120)
                      }}
                      onChange={(event) => setStopInput(stop.id, event.target.value)}
                      placeholder={
                        stop.kind === 'origin'
                          ? 'Choose origin'
                          : stop.kind === 'destination'
                            ? 'Choose destination'
                            : 'Add stop'
                      }
                    />

                    {isActive && searchResults.length > 0 && (
                      <ul className="search-results inline-suggest">
                        {searchResults.map((result) => (
                          <li key={result.id ?? `${result.latitude}-${result.longitude}`}>
                            <button type="button" onMouseDown={() => applyPlaceToActiveStop(result)}>
                              {[result.name, result.admin1, result.country].filter(Boolean).join(', ')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {isActive && isSearching && <p className="hint inline-hint">Searching places...</p>}
                  </div>

                  {stop.kind === 'via' && (
                    <div className="row stop-actions">
                      <button type="button" onClick={() => moveStop(stop.id, -1)} disabled={!canMoveUp}>
                        Up
                      </button>
                      <button type="button" onClick={() => moveStop(stop.id, 1)} disabled={!canMoveDown}>
                        Down
                      </button>
                      <button type="button" className="danger" onClick={() => removeStop(stop.id)}>
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="row directions-footer">
            <button type="button" onClick={addViaStop}>
              + Add Stop
            </button>
            <p className="hint">Map click adds location to focused input only.</p>
          </div>
        </section>

        <section className="card">
          <label>Trip time</label>
          <div className="row time-mode-toggle">
            <button
              type="button"
              className={`mode-btn ${tripTimeMode === 'depart' ? 'active' : ''}`}
              onClick={() => setTripTimeMode('depart')}
            >
              Depart at
            </button>
            <button
              type="button"
              className={`mode-btn ${tripTimeMode === 'arrive' ? 'active' : ''}`}
              onClick={() => setTripTimeMode('arrive')}
            >
              Arrive at
            </button>
          </div>

          <label htmlFor="tripStart" className="inline-label">
            {tripTimeMode === 'depart' ? 'Departure time' : 'Arrival time'}
          </label>
          <input
            id="tripStart"
            type="datetime-local"
            value={tripStart}
            onChange={(event) => setTripStart(event.target.value)}
          />
          <p className="hint">Forecast window is up to {MAX_FORECAST_DAYS} days ahead.</p>
        </section>

        <section className="card action-card">
          <label htmlFor="weatherPointCount">Weather checkpoints along route: {weatherPointCount}</label>
          <input
            id="weatherPointCount"
            type="range"
            min={MIN_WEATHER_POINTS}
            max={MAX_WEATHER_POINTS}
            value={weatherPointCount}
            onChange={(event) => setWeatherPointCount(Number(event.target.value))}
          />

          <div className="row actions">
            <button type="button" onClick={exportItinerary} disabled={!hasTripData}>
              Export GPX
            </button>
          </div>

          <div className="stats">
            <p>
              Distance: <strong>{routeDistanceM > 0 ? distanceLabel(routeDistanceM) : '-'}</strong>
            </p>
            <p>
              Duration: <strong>{routeDurationS > 0 ? durationLabel(routeDurationS) : '-'}</strong>
            </p>
          </div>

          {error && <p className="error">{error}</p>}
          {error && (
            <button
              type="button"
              className="text-action"
              onClick={() => void buildRoute(false)}
              disabled={isRouting || stops.length < 2 || stops.some((stop) => stop.waypoint === null)}
            >
              Retry route and weather
            </button>
          )}
          {hasTripData && (
            <button type="button" className="text-action" onClick={clearTrip}>
              Start over
            </button>
          )}
        </section>

        <section className="card">
          <details className="weather-dropdown">
            <summary>
              Weather checkpoints
              <span>{weatherSamples.length}</span>
            </summary>

            <ul className="weather-list">
              {weatherSamples.length === 0 && <li className="empty">No weather samples loaded yet.</li>}
              {weatherSamples.map((sample, idx) => (
                <li key={sample.id}>
                  <strong>Point {idx + 1} - at {sample.locationName} (km {sample.routeKm.toFixed(1)})</strong>
                  <p>{format(new Date(sample.etaIso), 'EEE, MMM d HH:mm')}</p>
                  <p>
                    {sample.tempC.toFixed(1)} C, {sample.precipProb}% rain, {sample.windKph.toFixed(0)} km/h wind
                  </p>
                  <p>
                    {weatherCodeText[sample.code] ?? 'Unknown conditions'} ({sample.isDay ? 'Day' : 'Night'})
                  </p>
                </li>
              ))}
            </ul>
          </details>
        </section>
      </aside>

      <section className="map-wrap">
        <MapContainer center={[34.02, -6.84]} zoom={6} scrollWheelZoom className="map-root">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <MapClickCapture enabled={activeStopId !== null} onPickLocation={assignMapPickToActiveStop} />

          {routePoints.length > 1 && <FitToRoute points={routePoints} />}

          {routePoints.length > 1 && <Polyline positions={routePoints} pathOptions={{ color: '#f25f3a', weight: 5 }} />}

          {resolvedStops.map((stop, idx) => (
            <Marker
              key={stop.id}
              position={[stop.waypoint.lat, stop.waypoint.lon]}
              icon={createStopIcon(stop.kind, idx)}
            >
              <Popup>
                <strong>
                  {stop.kind === 'origin' ? 'Start' : stop.kind === 'destination' ? 'Destination' : `Stop ${idx}`}: {stop.waypoint.name}
                </strong>
                <br />
                {stop.waypoint.lat.toFixed(4)}, {stop.waypoint.lon.toFixed(4)}
              </Popup>
            </Marker>
          ))}

          {weatherSamples.map((sample, idx) => (
            <Marker
              key={sample.id}
              position={[sample.lat, sample.lon]}
              icon={createWeatherIconWithTemp(sample.code, sample.isDay, sample.tempC)}
            >
              <Popup>
                <strong>Weather Point {idx + 1}</strong>
                <br />
                At: {sample.locationName}
                <br />
                Route km: {sample.routeKm.toFixed(1)}
                <br />
                ETA: {format(new Date(sample.etaIso), 'EEE, MMM d HH:mm')}
                <br />
                Temp: {sample.tempC.toFixed(1)} C
                <br />
                Rain chance: {sample.precipProb}%
                <br />
                Wind: {sample.windKph.toFixed(0)} km/h
                <br />
                Condition: {weatherCodeText[sample.code] ?? 'Unknown'} ({sample.isDay ? 'Day' : 'Night'})
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </section>
    </main>
  )
}

export default App
