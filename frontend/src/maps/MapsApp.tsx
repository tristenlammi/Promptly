import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, BatteryCharging, Bike, Bookmark, Briefcase, Car, ChevronDown, ChevronUp, Clock, SlidersHorizontal, Crosshair, Footprints, GripVertical,
  Home, List, Loader2, MapPin, Navigation, ParkingCircle, Plus, Route as RouteIcon, Search, TrafficCone, Trash2, User, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useIsMobile } from "@/hooks/useIsMobile";
import { confirm } from "@/components/shared/ConfirmDialog";
import { apiErrorMessage } from "@/utils/apiError";
import { isAndroidDevice } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";

import { useKeyboardInset } from "@/components/files/documents/useKeyboardInset";
import { NEARBY, mapsApi, decodeShape, formatDuration, formatKm, routeSeconds, trafficLine, type Charger, type Mode, type PlaceMore, type PreferredRoute, type Route, type SavedPlace, type SearchResult, type Spot } from "./api";
import { MapView, placeLook, type MapViewHandle } from "./MapView";
import { PeoplePanel, useShares } from "./People";
import { PLACE_COLOURS, PLACE_ICON_SVG, PLACE_ICONS } from "./placeIcons";
import { TimelinePanel } from "./Timeline";

type Panel = "home" | "place" | "route" | "charger" | "timeline" | "people";

const MODES: { id: Mode; label: string; icon: typeof Car }[] = [
  { id: "drive", label: "Drive", icon: Car },
  { id: "cycle", label: "Cycle", icon: Bike },
  { id: "walk", label: "Walk", icon: Footprints },
];

const PLUGS = ["Type 2", "CCS2", "CHAdeMO", "Tesla"];

const KIND_ICON: Record<string, typeof Car> = {
  home: Home, work: Briefcase, favourite: Bookmark, list: List, contact: User, recent: Clock, place: MapPin, address: MapPin, pin: MapPin,
};

interface StopRow extends Spot {
  key: string;
}

/** The same spot, near enough: within a few metres. */
const samePlace = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.abs(a.lat - b.lat) < 0.0001 && Math.abs(a.lon - b.lon) < 0.0001;

const NO_PLACES: SavedPlace[] = [];

let stopKey = 0;
const asStop = (s: Spot): StopRow => ({ lat: s.lat, lon: s.lon, name: s.name, address: s.address, key: String(++stopKey) });

export function MapsApp({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const keyboard = useKeyboardInset();
  const map = useRef<MapViewHandle>(null);
  const { data: config } = useQuery({
    queryKey: ["maps-config"],
    queryFn: mapsApi.config,
    staleTime: 3_600_000,
    refetchInterval: (q) => (q.state.data?.ready ? false : 30_000),
  });
  const { data: mine } = useQuery({ queryKey: ["maps-mine"], queryFn: mapsApi.mine });
  const refreshMine = useCallback(() => void qc.invalidateQueries({ queryKey: ["maps-mine"] }), [qc]);
  const { data: usualRoutes } = useQuery({ queryKey: ["maps-preferred"], queryFn: mapsApi.preferred });
  const refreshUsual = useCallback(() => void qc.invalidateQueries({ queryKey: ["maps-preferred"] }), [qc]);
  const { data: shares } = useShares();
  const friends = useMemo(() => (shares?.shared_with_me ?? []).filter((p) => p.live), [shares]);

  const [panel, setPanel] = useState<Panel>("home");
  const [open, setOpen] = useState(true);
  const [place, setPlace] = useState<SearchResult | null>(null);
  const [charger, setCharger] = useState<Charger | null>(null);

  // Where you are, while the map is open.
  const [you, setYou] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const centredOnYou = useRef(false);
  const [locationBlocked, setLocationBlocked] = useState(false);
  const [watching, setWatching] = useState(0);
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const here = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
        setYou(here);
        if (!centredOnYou.current) {
          centredOnYou.current = true;
          map.current?.flyTo(here.lat, here.lon, 13);
        }
      },
      (e) => setLocationBlocked(e.code === e.PERMISSION_DENIED),
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [watching]);
  // Phones can quietly end a watch while the app's in the background, such as during
  // a drive in the navigation screen. Coming back starts a fresh one.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") setWatching((n) => n + 1);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  const noLocationYet = () => (locationBlocked ? "Promptly isn't allowed to use your location. Turn it on in your phone's settings." : "Waiting for your location.");

  // The day you're looking at on your timeline.
  const [dayOnMap, setDayOnMap] = useState<{ lines: [number, number][][]; stays: { lat: number; lon: number; name: string }[] } | null>(null);

  // ---- Search ----
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTyped(query.trim()), 220);
    return () => window.clearTimeout(t);
  }, [query]);
  const { data: results, isFetching: searching, error: searchError } = useQuery({
    queryKey: ["maps-search", typed],
    queryFn: () => mapsApi.search(typed, you ?? map.current?.center() ?? null),
    enabled: typed.length > 1,
    staleTime: 60_000,
    retry: false,
  });

  const showPlace = useCallback((s: SearchResult) => {
    setPlace(s);
    setPanel("place");
    setOpen(true);
    setQuery("");
    map.current?.flyTo(s.lat, s.lon);
  }, []);

  const hold = useCallback(async (lat: number, lon: number) => {
    setPlace({ kind: "pin", name: "Dropped pin", lat, lon });
    setPanel("place");
    setOpen(true);
    try {
      setPlace(await mapsApi.reverse(lat, lon));
    } catch {
      /* it stays a dropped pin */
    }
  }, []);

  // Another app sent you here: /maps?to=lat,lon,name (and /maps?q=text, above).
  useEffect(() => {
    const to = params.get("to");
    if (!to) return;
    const [lat, lon, ...name] = to.split(",");
    const spot = { lat: Number(lat), lon: Number(lon), name: name.join(",") || "Dropped pin" };
    setParams({}, { replace: true });
    if (Number.isFinite(spot.lat) && Number.isFinite(spot.lon)) window.setTimeout(() => showPlace({ kind: "place", ...spot }), 800);
    // Only the link you arrived with.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Directions ----
  const [stops, setStops] = useState<StopRow[]>([]);
  const [mode, setMode] = useState<Mode>("drive");
  const [avoid, setAvoid] = useState({ tolls: false, highways: false, ferries: false });
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selected, setSelected] = useState(0);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [addingStop, setAddingStop] = useState(false);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  // Roads you chose to go along, as points tapped on them.
  const [via, setVia] = useState<{ lat: number; lon: number; name: string }[]>([]);
  const viaRef = useRef(via);
  viaRef.current = via;
  const [pickingVia, setPickingVia] = useState(false);
  const [nearMarks, setNearMarks] = useState<SearchResult[]>([]);
  const panelPadding = useCallback(() => {
    return !isMobile ? { top: 40, bottom: 40, left: 420, right: 40 } : { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 30, right: 30 };
  }, [isMobile]);

  const runRoute = useCallback(async (rows: StopRow[], bestOrder = false) => {
    if (rows.length < 2) {
      setRoutes([]);
      return;
    }
    setRouting(true);
    setRouteError(null);
    try {
      const got = await mapsApi.route(rows, {
        mode,
        avoid_tolls: avoid.tolls,
        avoid_highways: avoid.highways,
        avoid_ferries: avoid.ferries,
        best_order: bestOrder,
        via: viaRef.current.map((v) => ({ lat: v.lat, lon: v.lon })),
      });
      if (bestOrder) setStops(got.order.map((i) => rows[i]));
      setRoutes(got.routes);
      setSelected(0);
      const line = got.routes[0].legs.flatMap((l) => decodeShape(l.shape));
      map.current?.fit(line, panelPadding());
    } catch (e) {
      setRoutes([]);
      setRouteError(apiErrorMessage(e, "No route between these places."));
    } finally {
      setRouting(false);
    }
  }, [mode, avoid, panelPadding]);

  useEffect(() => {
    if (panel === "route") void runRoute(stopsRef.current);
    // Changing how you travel asks again. The stops do so themselves below.
  }, [mode, avoid]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeStops = (rows: StopRow[]) => {
    setStops(rows);
    void runRoute(rows);
  };

  const directionsTo = (s: Spot) => {
    void mapsApi.recent(s).then(refreshMine).catch(() => undefined);
    const from: StopRow[] = you ? [asStop({ lat: you.lat, lon: you.lon, name: "Your location" })] : [];
    const rows = [...from, asStop(s)];
    setPanel("route");
    setOpen(true);
    setAddingStop(!you);
    changeStops(rows);
  };

  const changeVia = (rows: { lat: number; lon: number; name: string }[]) => {
    viaRef.current = rows;
    setVia(rows);
    void runRoute(stopsRef.current);
  };

  const addVia = async (lat: number, lon: number) => {
    setPickingVia(false);
    const named = await mapsApi.reverse(lat, lon).catch(() => null);
    const road = named?.address?.split(",")[0] || named?.name || "That road";
    changeVia([...viaRef.current, { lat, lon, name: road.replace(/^\d+\S*\s+/, "") }]);
  };

  const leaveRoute = () => {
    viaRef.current = [];
    setVia([]);
    setPickingVia(false);
    setNearMarks([]);
    setStops([]);
    setRoutes([]);
    setRouteError(null);
    setAddingStop(false);
    setPanel("home");
  };

  // Between these two places, always go this way.
  const preferSelected = async () => {
    const route = routes[selected];
    if (!route || stops.length !== 2) return;
    const same = routes.find((r) => r.preferred);
    if (same && same !== route) {
      const ok = await confirm({
        title: "Change your usual way?",
        message: `You usually go ${same.via_name ? `via ${same.via_name}` : "another way"} between these places. This will use ${route.via_name ? `the way via ${route.via_name}` : "this way"} instead.`,
        confirmLabel: "Change it",
      });
      if (!ok) return;
    }
    if (!route.through?.length) {
      toast.error("This trip is too short to save a way for.");
      return;
    }
    try {
      await mapsApi.prefer(stops[0], stops[1], route.through, mode);
      refreshUsual();
      toast.success("This is now your usual way");
      // It's saved, so it no longer needs the roads you picked to get there.
      viaRef.current = [];
      setVia([]);
      await runRoute(stops);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    }
  };

  const stopPreferring = async (id: string) => {
    await mapsApi.unprefer(id);
    refreshUsual();
    await runRoute(stops);
  };

  const startDriving = async () => {
    if (!isAndroidDevice()) {
      toast.info("Turn-by-turn runs in the Promptly app on your Android phone.");
      return;
    }
    try {
      const code = await mapsApi.pairCode();
      const params = new URLSearchParams({
        server: window.location.origin,
        code,
        mode,
        tolls: avoid.tolls ? "1" : "0",
        highways: avoid.highways ? "1" : "0",
        ferries: avoid.ferries ? "1" : "0",
        stops: stops.map((s) => `${s.lat},${s.lon},${s.name.replaceAll(";", " ")}`).join(";"),
      });
      // Drive the way you picked, not whichever the phone would have chosen.
      const picked = routes[selected]?.through ?? [];
      if (stops.length === 2 && picked.length) params.set("through", picked.map((p) => `${p.lat},${p.lon},${p.heading ?? ""}`).join(";"));
      window.location.href = `promptlymaps://navigate?${params.toString()}`;
      // Still here shortly after: nothing took the link.
      window.setTimeout(() => {
        if (document.visibilityState === "visible") toast.info("Didn't open? Turn-by-turn needs the latest Promptly app, from Apps → Install apps.");
      }, 2500);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't start navigation."));
    }
  };

  // A whole trip sent from elsewhere: /maps?route=lat,lon,name;lat,lon,name&mode=.
  const runRouteLatest = useRef(runRoute);
  runRouteLatest.current = runRoute;
  useEffect(() => {
    const raw = params.get("route");
    if (!raw) return;
    const wanted = params.get("mode");
    if (wanted === "walk" || wanted === "cycle" || wanted === "drive") setMode(wanted);
    const rows = raw.split(";").map((row) => {
      const [lat, lon, ...name] = row.split(",");
      return asStop({ lat: Number(lat), lon: Number(lon), name: name.join(",") || "Stop" });
    }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    setParams({}, { replace: true });
    if (rows.length < 2) return;
    setStops(rows);
    setPanel("route");
    window.setTimeout(() => void runRouteLatest.current(rows), 900);
    // Only the link you arrived with.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Traffic across the map. Your route always shows its own traffic; this
  // layer spends requests as you look around, so it's off until you ask, and
  // turns itself off after 10 minutes. ----
  const [trafficOn, setTrafficOn] = useState(false);
  const toggleTraffic = () => setTrafficOn((on) => !on);
  useEffect(() => {
    if (!trafficOn) return;
    const t = window.setTimeout(() => setTrafficOn(false), 600_000);
    return () => window.clearTimeout(t);
  }, [trafficOn]);

  // ---- Chargers ----
  const [chargersOn, setChargersOn] = useState(false);
  const [alongRoute, setAlongRoute] = useState(false);
  const [plug, setPlug] = useState<string | null>(null);
  const [minKw, setMinKw] = useState<number | null>(null);
  const [chargers, setChargers] = useState<Charger[]>([]);
  const loadChargers = useCallback(async () => {
    if (!chargersOn) {
      setChargers([]);
      return;
    }
    const route = routes[selected];
    try {
      if (alongRoute && route) {
        setChargers(await mapsApi.chargersAlong(route.legs.map((l) => l.shape), plug, minKw));
      } else {
        const box = map.current?.bounds();
        if (box) setChargers(await mapsApi.chargers(box, plug, minKw));
      }
    } catch {
      setChargers([]);
    }
  }, [chargersOn, alongRoute, routes, selected, plug, minKw]);
  useEffect(() => {
    void loadChargers();
  }, [loadChargers]);
  const moved = useRef(loadChargers);
  moved.current = loadChargers;
  const alongRef = useRef(alongRoute);
  alongRef.current = alongRoute;
  const onMoved = useCallback(() => {
    if (!alongRef.current) void moved.current();
  }, []);

  // ---- Saving ----
  const saved = useMemo(() => {
    const rows = mine?.places ?? [];
    return {
      home: rows.find((p) => p.kind === "home"),
      work: rows.find((p) => p.kind === "work"),
      rest: rows.filter((p) => p.kind !== "home" && p.kind !== "work"),
    };
  }, [mine]);

  const savedOnMap = mine?.places ?? NO_PLACES;

  const save = async (s: Spot, kind: SavedPlace["kind"], listName?: string, look?: { name: string; icon: string; colour: string }) => {
    const current = kind === "home" ? saved.home : kind === "work" ? saved.work : undefined;
    if (current) {
      if (samePlace(current, s)) return;
      const word = kind === "home" ? "Home" : "Work";
      const ok = await confirm({
        title: `Replace ${word}?`,
        message: `${word} is set to ${current.address ?? "another place"}. This will change it to ${s.address ?? s.name}.`,
        confirmLabel: `Replace ${word}`,
      });
      if (!ok) return;
    }
    try {
      const name = kind === "home" ? "Home" : kind === "work" ? "Work" : look?.name || s.name;
      await mapsApi.save({ lat: s.lat, lon: s.lon, name, kind, list_name: listName ?? null, icon: look?.icon ?? null, colour: look?.colour ?? null, address: s.address ?? (kind === "home" || kind === "work" ? s.name : null) });
      refreshMine();
      toast.success(kind === "home" ? "Saved as Home" : kind === "work" ? "Saved as Work" : "Saved");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that place."));
    }
  };

  const parkHere = async () => {
    if (!you) {
      toast.error(noLocationYet());
      return;
    }
    await mapsApi.park(you.lat, you.lon);
    refreshMine();
    toast.success("Parked here");
  };

  // ---- Not set up ----
  if (config && !config.basemap) {
    return (
      <Shell embedded={embedded}>
        <div className="flex h-full items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <Navigation className="mx-auto mb-3 h-8 w-8 text-[var(--accent-text)]" />
            {config.building ? (
              <>
                <h1 className="text-lg font-semibold text-[var(--text)]">Building your map</h1>
                <p className="mt-1 text-sm text-[var(--text-muted)]">This server is downloading and preparing the map. It takes a while the first time and carries on by itself.</p>
              </>
            ) : (
              <>
                <h1 className="text-lg font-semibold text-[var(--text)]">Maps aren't set up on this server</h1>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  {config.failed ? "The last map build stopped. An admin can see why in the Promptly-Maps log." : 'An admin can turn them on by adding "maps" to COMPOSE_PROFILES.'}
                </p>
              </>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const route = routes[selected];
  // On the directions panel, results show in the panel itself.
  const showResults = panel !== "route" && query.trim().length > 1;
  const body = (
    <>
      {panel === "home" && (
        <HomePanel
          nearby={<NearbyPanel centre={() => you ?? map.current?.center() ?? null} onShow={(r) => showPlace(r)} onMarks={setNearMarks} />}
          home={saved.home}
          work={saved.work}
          places={saved.rest}
          recents={mine?.recents ?? []}
          parked={mine?.parked ?? null}
          onGo={directionsTo}
          onShow={(s) => showPlace({ kind: "place", ...s })}
          onPark={parkHere}
          onUnpark={async () => {
            await mapsApi.unpark();
            refreshMine();
          }}
          onRemove={async (id) => {
            await mapsApi.remove(id);
            refreshMine();
          }}
          onClearRecents={async () => {
            await mapsApi.clearRecents();
            refreshMine();
          }}
          onTimeline={() => setPanel("timeline")}
          onPeople={() => setPanel("people")}
          usual={usualRoutes ?? []}
          onGoUsual={(r) => {
            const rows = [asStop(r.from), asStop(r.to)];
            setMode(r.mode);
            setStops(rows);
            setPanel("route");
            window.setTimeout(() => void runRouteLatest.current(rows), 0);
          }}
          onRemoveUsual={async (id) => {
            await mapsApi.unprefer(id);
            refreshUsual();
          }}
          onToleranceUsual={async (id, minutes) => {
            await mapsApi.editPreferred(id, { tolerance_minutes: minutes });
            refreshUsual();
          }}
          friends={friends.length}
          config={config ?? null}
        />
      )}
      {panel === "place" && place && (
        <PlacePanel
          key={`${place.lat},${place.lon}`}
          place={place}
          isHome={!!saved.home && samePlace(saved.home, place)}
          isWork={!!saved.work && samePlace(saved.work, place)}
          already={saved.rest.find((p) => samePlace(p, place))}
          onEdited={refreshMine}
          onClose={() => setPanel(stops.length ? "route" : "home")} onDirections={() => directionsTo(place)} onSave={(kind, list, look) => save(place, kind, list, look)} addTo={stops.length > 0 ? () => {
          changeStops([...stops, asStop(place)]);
          setPanel("route");
        } : undefined} />
      )}
      {panel === "charger" && charger && (
        <ChargerPanel charger={charger} onClose={() => setPanel(stops.length ? "route" : "home")} onDirections={() => directionsTo({ lat: charger.lat, lon: charger.lon, name: charger.name, address: charger.operator })} addTo={stops.length > 0 ? () => {
          const at = alongRoute && charger.along_m !== undefined ? Math.max(1, stops.length - 1) : stops.length;
          const rows = [...stops];
          rows.splice(at, 0, asStop({ lat: charger.lat, lon: charger.lon, name: charger.name }));
          changeStops(rows);
          setPanel("route");
        } : undefined} />
      )}
      {panel === "people" && (
        <PeoplePanel
          onClose={() => setPanel("home")}
          onShow={(p) => p.live && showPlace({ kind: "contact", name: p.name, address: p.live.destination ? `Going to ${p.live.destination}` : null, lat: p.live.lat, lon: p.live.lon })}
        />
      )}
      {panel === "timeline" && (
        <TimelinePanel
          onClose={() => {
            setDayOnMap(null);
            setPanel("home");
          }}
          onShowDay={(day) => {
            setDayOnMap(day);
            const all: [number, number][] = [...day.lines.flat(), ...day.stays.map((s): [number, number] => [s.lon, s.lat])];
            if (all.length) map.current?.fit(all, panelPadding());
          }}
        />
      )}
      {panel === "route" && (
        <RoutePanel
          stops={stops}
          mode={mode}
          setMode={setMode}
          avoid={avoid}
          setAvoid={setAvoid}
          routes={routes}
          selected={selected}
          setSelected={setSelected}
          routing={routing}
          error={routeError}
          adding={addingStop}
          setAdding={setAddingStop}
          results={results}
          query={query}
          setQuery={setQuery}
          onClose={leaveRoute}
          onChange={changeStops}
          onBestOrder={() => void runRoute(stops, true)}
          onPrefer={() => void preferSelected()}
          onStopPreferring={(id) => void stopPreferring(id)}
          onStart={startDriving}
          via={via}
          pickingVia={pickingVia}
          onPickVia={setPickingVia}
          onRemoveVia={(i) => changeVia(via.filter((_, n) => n !== i))}
          onMarks={setNearMarks}
          onAddOnWay={(s) => changeStops([...stops.slice(0, -1), asStop(s), stops[stops.length - 1]])}
          onAddStop={(s) => {
            // With one stop so far, that's where you're going: this is where from.
            changeStops(stops.length === 1 ? [asStop(s), ...stops] : [...stops, asStop(s)]);
            setAddingStop(false);
            setQuery("");
          }}
        />
      )}
    </>
  );

  return (
    <Shell embedded={embedded}>
      <div className="relative h-full w-full overflow-hidden">
        <MapView
          ref={map}
          basemap={config?.basemap ?? null}
          routes={routes}
          selected={selected}
          pin={panel === "place" ? place : panel === "charger" && charger ? { lat: charger.lat, lon: charger.lon, name: charger.name } : null}
          stops={stops}
          chargers={chargers}
          parked={mine?.parked ?? null}
          you={you}
          saved={savedOnMap}
          showTraffic={!!config?.traffic && trafficOn}
          onPickIncident={(i) => showPlace({ kind: "pin", name: i.label, address: i.text !== i.label ? i.text : null, lat: i.lat, lon: i.lon })}
          marks={dayOnMap?.stays ?? nearMarks}
          onPickPoint={pickingVia ? (lat, lon) => void addVia(lat, lon) : undefined}
          trail={dayOnMap?.lines}
          onPickSaved={(p) => showPlace({ ...p })}
          friends={friends}
          onHold={hold}
          onPick={(s) => showPlace({ kind: "place", ...s })}
          onPickCharger={(c) => {
            setCharger(c);
            setPanel("charger");
            setOpen(true);
          }}
          onPickRoute={setSelected}
          onPickParked={() => mine?.parked && showPlace({ kind: "place", lat: mine.parked.lat, lon: mine.parked.lon, name: "Your car", address: mine.parked.note })}
          onMoved={onMoved}
        />

        {/* Search, and the panel beneath it on a big screen. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2 p-3 md:w-[400px]">
          {panel !== "route" && (
            <div className="pointer-events-auto relative">
              <div className="flex h-12 items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 shadow-lg">
                {searching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" /> : <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search for a place, address or person"
                  aria-label="Search the map"
                  className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
                />
                {query && (
                  <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="rounded-full p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {showResults && (
                <div style={{ maxHeight: `min(60dvh, calc(100dvh - 7rem - ${keyboard}px))` }} className="mt-2 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
                  {searchError ? (
                    <p className="px-4 py-3 text-sm text-[var(--text-muted)]">{apiErrorMessage(searchError, "Search isn't available right now.")}</p>
                  ) : results && results.length === 0 && !searching ? (
                    <p className="px-4 py-3 text-sm text-[var(--text-muted)]">Nothing found.</p>
                  ) : (
                    (results ?? []).map((r, i) => <ResultRow key={`${r.lat},${r.lon},${i}`} result={r} onPick={() => showPlace(r)} />)
                  )}
                </div>
              )}
            </div>
          )}
          {!showResults && !isMobile && (
            <div className="pointer-events-auto flex min-h-0 flex-col overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-lg" style={{ maxHeight: panel === "route" ? "calc(100vh - 1.5rem - var(--maps-top, 0px))" : "calc(100vh - 6rem - var(--maps-top, 0px))" }}>
              {body}
            </div>
          )}
        </div>

        {/* On a phone, the same panel rises from the bottom. */}
        {!showResults && isMobile && (
          <div
            style={{ bottom: keyboard, maxHeight: keyboard || addingStop ? `calc(100% - ${keyboard}px - 3rem)` : "62%" }}
            className="absolute inset-x-0 z-10 flex flex-col rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] shadow-[0_-4px_20px_rgba(0,0,0,0.15)]"
          >
            <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? "Collapse the panel" : "Expand the panel"} className="flex shrink-0 justify-center py-2 text-[var(--text-muted)]">
              {open ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
            </button>
            {open && (panel === "route" && pickingVia ? (
              // The map's what you need to see: only this, until you've tapped.
              <div className="flex items-center justify-between gap-3 px-4 pb-4 text-sm text-[var(--text)]">
                <span>Tap the road you want to go along.</span>
                <button type="button" onClick={() => setPickingVia(false)} className="shrink-0 text-[var(--accent-text)] underline">Cancel</button>
              </div>
            ) : (
              <div className="min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">{body}</div>
            ))}
          </div>
        )}

        {/* Map buttons. */}
        <div className={`absolute right-3 top-[4.5rem] z-10 flex-col gap-2 md:top-3 ${isMobile && (addingStop || keyboard > 0) ? "hidden" : "flex"}`}>
          <MapButton label="Go to your location" onClick={() => (you ? map.current?.flyTo(you.lat, you.lon, 15) : toast.info(noLocationYet()))}>
            <Crosshair className="h-5 w-5" />
          </MapButton>
          <MapButton label={chargersOn ? "Hide charging stations" : "Show charging stations"} active={chargersOn} onClick={() => setChargersOn((v) => !v)}>
            <BatteryCharging className="h-5 w-5" />
          </MapButton>
          {config?.traffic && (
            <MapButton label={trafficOn ? "Hide traffic across the map" : "Show traffic across the map"} active={trafficOn} onClick={toggleTraffic}>
              <TrafficCone className="h-5 w-5" />
            </MapButton>
          )}
        </div>
        {chargersOn && (
          <div className="absolute right-14 top-[4.5rem] z-10 flex max-w-[calc(100%-5rem)] flex-wrap justify-end gap-1 md:top-3 md:right-16">
            {PLUGS.map((p) => (
              <Chip key={p} on={plug === p} onClick={() => setPlug(plug === p ? null : p)}>{p}</Chip>
            ))}
            <Chip on={minKw === 50} onClick={() => setMinKw(minKw === 50 ? null : 50)}>Fast (50 kW+)</Chip>
            {route && <Chip on={alongRoute} onClick={() => setAlongRoute((v) => !v)}>On my route</Chip>}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  return <div className={embedded ? "h-full w-full" : "fixed inset-0 bg-[var(--bg)]"}>{children}</div>;
}

function MapButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] shadow-lg transition ${active ? "bg-[#2F9E6E] text-white" : "bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]"}`}
    >
      {children}
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`rounded-full border px-2.5 py-1 text-xs shadow ${on ? "border-transparent bg-[#2F9E6E] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"}`}>
      {children}
    </button>
  );
}

function ResultRow({ result, onPick }: { result: SearchResult; onPick: () => void }) {
  const Icon = KIND_ICON[result.kind] ?? MapPin;
  return (
    <button type="button" onClick={onPick} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[var(--hover)]">
      <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0">
        <span className="block truncate text-sm text-[var(--text)]">{result.name}</span>
        {result.address && <span className="block truncate text-xs text-[var(--text-muted)]">{result.address}</span>}
      </span>
    </button>
  );
}

function Row({ icon: Icon, look, title, detail, onClick, trailing }: { icon: typeof Car; look?: { colour: string; svg: string }; title: string; detail?: string | null; onClick?: () => void; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 pr-2 hover:bg-[var(--hover)]">
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left">
        {look ? (
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke={look.colour} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0" dangerouslySetInnerHTML={{ __html: look.svg }} />
        ) : (
          <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm text-[var(--text)]">{title}</span>
          {detail && <span className="block truncate text-xs text-[var(--text-muted)]">{detail}</span>}
        </span>
      </button>
      {trailing}
    </div>
  );
}

function SmallIcon({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
      {children}
    </button>
  );
}

function Heading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-1 pt-3">
      <h2 className="text-xs font-medium text-[var(--text-muted)]">{children}</h2>
      {action}
    </div>
  );
}

function HomePanel(p: {
  nearby: React.ReactNode;
  home?: SavedPlace;
  work?: SavedPlace;
  places: SavedPlace[];
  recents: Spot[];
  parked: { lat: number; lon: number; note: string | null; at: string } | null;
  onGo: (s: Spot) => void;
  onShow: (s: Spot) => void;
  onPark: () => void;
  onUnpark: () => void;
  onRemove: (id: string) => void;
  onClearRecents: () => void;
  onTimeline: () => void;
  onPeople: () => void;
  usual: PreferredRoute[];
  onGoUsual: (r: PreferredRoute) => void;
  onRemoveUsual: (id: string) => void;
  onToleranceUsual: (id: string, minutes: number) => void;
  friends: number;
  config: { attribution: string; osm_data: string | null; built_at: string | null } | null;
}) {
  const lists = useMemo(() => {
    const out = new Map<string, SavedPlace[]>();
    for (const row of p.places) {
      const name = row.kind === "list" && row.list_name ? row.list_name : "Favourites";
      out.set(name, [...(out.get(name) ?? []), row]);
    }
    return [...out.entries()];
  }, [p.places]);
  return (
    <div className="pb-3">
      <div className="grid grid-cols-2 gap-2 p-3">
        <Shortcut icon={Home} label="Home" detail={p.home?.address ?? p.home?.name ?? "Search, then save as Home"} onClick={p.home ? () => p.onGo({ ...p.home!, name: "Home" }) : undefined} />
        <Shortcut icon={Briefcase} label="Work" detail={p.work?.address ?? p.work?.name ?? "Search, then save as Work"} onClick={p.work ? () => p.onGo({ ...p.work!, name: "Work" }) : undefined} />
      </div>
      {p.parked ? (
        <Row
          icon={ParkingCircle}
          title="Your car"
          detail={`Parked ${new Date(p.parked.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}
          onClick={() => p.onGo({ lat: p.parked!.lat, lon: p.parked!.lon, name: "Your car" })}
          trailing={<SmallIcon label="Forget where you parked" onClick={p.onUnpark}><X className="h-4 w-4" /></SmallIcon>}
        />
      ) : (
        <Row icon={ParkingCircle} title="Save where you parked" onClick={p.onPark} />
      )}
      {p.nearby}
      <Row icon={Clock} title="Your timeline" detail="Where you've been, by day" onClick={p.onTimeline} />
      <Row icon={Users} title="Live location" detail={p.friends ? `${p.friends} sharing with you` : "Share where you are with family"} onClick={p.onPeople} />
      {p.usual.length > 0 && (
        <div>
          <Heading>Your usual routes</Heading>
          {p.usual.map((r) => (
            <div key={r.id}>
              <Row icon={RouteIcon} title={r.name} onClick={() => p.onGoUsual(r)} trailing={<SmallIcon label={`Stop using ${r.name}`} onClick={() => p.onRemoveUsual(r.id)}><Trash2 className="h-4 w-4" /></SmallIcon>} />
              <label className="flex items-center gap-2 px-4 pb-2 pl-11 text-xs text-[var(--text-muted)]">
                Suggest another way if it saves
                <select value={r.tolerance_minutes} onChange={(e) => p.onToleranceUsual(r.id, Number(e.target.value))} className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[var(--text)]">
                  {[5, 10, 15, 20, 30].map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
      {lists.map(([name, rows]) => (
        <div key={name}>
          <Heading>{name}</Heading>
          {rows.map((row) => (
            <Row key={row.id} icon={row.kind === "list" ? List : Bookmark} look={placeLook(row)} title={row.name} detail={row.address} onClick={() => p.onShow(row)} trailing={<SmallIcon label={`Remove ${row.name}`} onClick={() => p.onRemove(row.id)}><Trash2 className="h-4 w-4" /></SmallIcon>} />
          ))}
        </div>
      ))}
      {p.recents.length > 0 && (
        <>
          <Heading action={<button type="button" onClick={p.onClearRecents} className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Clear</button>}>Recent</Heading>
          {p.recents.slice(0, 6).map((r) => (
            <Row key={`${r.lat},${r.lon}`} icon={Clock} title={r.name} detail={r.address} onClick={() => p.onShow(r)} />
          ))}
        </>
      )}
      {p.config?.built_at && (
        <p className="px-4 pt-3 text-[11px] text-[var(--text-muted)]">
          Map data from {new Date(p.config.osm_data || p.config.built_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}. {p.config.attribution}
        </p>
      )}
    </div>
  );
}

function Shortcut({ icon: Icon, label, detail, onClick }: { icon: typeof Car; label: string; detail: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="rounded-xl border border-[var(--border)] p-3 text-left transition enabled:hover:bg-[var(--hover)]">
      <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]"><Icon className="h-4 w-4 text-[var(--accent-text)]" />{label}</span>
      <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{detail}</span>
    </button>
  );
}

function PanelHeader({ title, detail, onClose }: { title: string; detail?: string | null; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 px-4 pt-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold text-[var(--text)]">{title}</h1>
        {detail && <p className="mt-0.5 text-sm text-[var(--text-muted)]">{detail}</p>}
      </div>
      <SmallIcon label="Close" onClick={onClose}><X className="h-4 w-4" /></SmallIcon>
    </div>
  );
}

function PrimaryButton({ icon: Icon, children, onClick }: { icon: typeof Car; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90">
      <Icon className="h-4 w-4" />{children}
    </button>
  );
}

function PlacePanel({ place, isHome, isWork, already, onEdited, onClose, onDirections, onSave, addTo }: {
  place: SearchResult;
  isHome: boolean;
  isWork: boolean;
  already?: SavedPlace;
  onEdited: () => void;
  onClose: () => void;
  onDirections: () => void;
  onSave: (kind: SavedPlace["kind"], list?: string, look?: { name: string; icon: string; colour: string }) => void;
  addTo?: () => void;
}) {
  const [picking, setPicking] = useState<"save" | "list" | null>(null);
  const title = already?.name ?? place.name;
  return (
    <div className="pb-4">
      <PanelHeader title={title} detail={place.address ?? already?.address ?? (place.category ? place.category.replaceAll("_", " ") : null)} onClose={onClose} />
      <div className="flex gap-2 px-4 pt-3">
        <PrimaryButton icon={Navigation} onClick={onDirections}>Directions</PrimaryButton>
        {addTo && (
          <button type="button" onClick={addTo} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
            <Plus className="h-4 w-4" />Add stop
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-4 pt-3">
        <SaveButton icon={Bookmark} on={!!already || picking === "save"} onClick={() => setPicking(picking === "save" ? null : "save")}>{already ? "Saved" : "Save"}</SaveButton>
        {!already && <SaveButton icon={List} on={picking === "list"} onClick={() => setPicking(picking === "list" ? null : "list")}>Add to list</SaveButton>}
        <SaveButton icon={Home} on={isHome} onClick={() => onSave("home")}>{isHome ? "Home" : "Set as Home"}</SaveButton>
        <SaveButton icon={Briefcase} on={isWork} onClick={() => onSave("work")}>{isWork ? "Work" : "Set as Work"}</SaveButton>
      </div>
      <MoreDetails place={place} />
      {picking && (
        <SavePicker
          place={place}
          already={already}
          withList={picking === "list" || already?.kind === "list"}
          onDone={() => setPicking(null)}
          onEdited={onEdited}
          onSave={(list, look) => {
            onSave(list ? "list" : "favourite", list, look);
            setPicking(null);
          }}
        />
      )}
      <p className="px-4 pt-3 text-xs text-[var(--text-muted)]">{place.lat.toFixed(5)}, {place.lon.toFixed(5)}</p>
    </div>
  );
}

/** Hours, phone and website, from TomTom. Only when you ask: it tells TomTom which place. */
function MoreDetails({ place }: { place: SearchResult }) {
  const { data: config } = useQuery({ queryKey: ["maps-config"], queryFn: mapsApi.config, staleTime: 3_600_000 });
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [more, setMore] = useState<PlaceMore | null>(null);
  if (!config?.traffic || place.kind === "pin") return null;
  const ask = async () => {
    setState("loading");
    try {
      setMore(await mapsApi.placeMore(place.name, place.lat, place.lon));
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  if (!more) {
    return (
      <div className="px-4 pt-3">
        <button type="button" onClick={() => void ask()} disabled={state === "loading"} className="text-xs text-[var(--accent-text)] hover:underline disabled:opacity-60">
          {state === "loading" ? "Looking it up…" : state === "failed" ? "Couldn't get details. Try again" : "More details"}
        </button>
        <span className="block text-[11px] text-[var(--text-muted)]">Hours, phone and website. Asks TomTom about this place.</span>
      </div>
    );
  }
  if (!more.found) return <p className="px-4 pt-3 text-xs text-[var(--text-muted)]">TomTom has no details for this place.</p>;
  const today = new Date().toLocaleDateString("en-CA");
  const hours = (more.hours ?? []).find((h) => h.date === today);
  return (
    <dl className="space-y-1 px-4 pt-3 text-sm">
      <div className="flex justify-between gap-3">
        <dt className="text-[var(--text-muted)]">Today</dt>
        <dd className="text-[var(--text)]">{hours ? `${hours.opens} to ${hours.closes}` : more.hours?.length ? "Closed" : "Hours not known"}</dd>
      </div>
      {more.phone && (
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--text-muted)]">Phone</dt>
          <dd><a href={`tel:${more.phone.replace(/[^\d+]/g, "")}`} className="text-[var(--accent-text)] hover:underline">{more.phone}</a></dd>
        </div>
      )}
      {more.url && (
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--text-muted)]">Website</dt>
          <dd className="min-w-0 truncate"><a href={more.url} target="_blank" rel="noreferrer noopener" className="text-[var(--accent-text)] hover:underline">{more.url.replace(/^https?:\/\//, "")}</a></dd>
        </div>
      )}
    </dl>
  );
}

/** Name it, and choose how it looks on your map. */
function SavePicker({ place, already, withList, onDone, onEdited, onSave }: {
  place: SearchResult;
  already?: SavedPlace;
  withList: boolean;
  onDone: () => void;
  onEdited: () => void;
  onSave: (list: string | undefined, look: { name: string; icon: string; colour: string }) => void;
}) {
  const [name, setName] = useState(already?.name ?? place.name);
  const [listName, setListName] = useState(already?.list_name ?? "");
  const [icon, setIcon] = useState(already?.icon ?? (withList ? "star" : "bookmark"));
  const [colour, setColour] = useState(already?.colour ?? PLACE_COLOURS[1]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (withList && !listName.trim())) return;
    if (!already) {
      onSave(withList ? listName.trim() : undefined, { name: name.trim(), icon, colour });
      return;
    }
    try {
      await mapsApi.editPlace(already.id, { name: name.trim(), icon, colour, ...(withList ? { list_name: listName.trim() } : {}) });
      onEdited();
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save that."));
    }
  };
  const remove = async () => {
    if (!already) return;
    await mapsApi.remove(already.id);
    onEdited();
    onDone();
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-4 mt-3 space-y-3 rounded-xl border border-[var(--border)] p-3">
      <label className="block text-xs text-[var(--text-muted)]">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="mt-1 h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text)] outline-none" />
      </label>
      {withList && (
        <label className="block text-xs text-[var(--text-muted)]">
          List
          <input value={listName} onChange={(e) => setListName(e.target.value)} maxLength={80} placeholder="Places to try" className="mt-1 h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text)] outline-none" />
        </label>
      )}
      <fieldset>
        <legend className="mb-1 text-xs text-[var(--text-muted)]">Icon</legend>
        <div className="grid grid-cols-5 gap-1">
          {PLACE_ICONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setIcon(option.id)}
              aria-label={option.label}
              aria-pressed={icon === option.id}
              title={option.label}
              className="flex h-9 items-center justify-center rounded-lg border hover:bg-[var(--hover)]"
              style={{ borderColor: icon === option.id ? colour : "transparent", color: icon === option.id ? colour : "var(--text-muted)" }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PLACE_ICON_SVG[option.id] }} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-xs text-[var(--text-muted)]">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {PLACE_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColour(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={colour === c}
              className="h-7 w-7 rounded-full border-2"
              style={{ backgroundColor: c, borderColor: colour === c ? "var(--text)" : "transparent" }}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-2">
        <button type="submit" className="h-9 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90">{already ? "Save changes" : "Save"}</button>
        <button type="button" onClick={onDone} className="h-9 rounded-lg px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">Cancel</button>
        {already && <button type="button" onClick={() => void remove()} className="ml-auto h-9 rounded-lg px-3 text-sm text-[var(--danger,#c0392b)] hover:bg-[var(--hover)]">Remove</button>}
      </div>
    </form>
  );
}

function SaveButton({ icon: Icon, on, children, onClick }: { icon: typeof Car; on?: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on === undefined ? undefined : on}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs hover:bg-[var(--hover)] ${on ? "border-[#D97757] text-[#D97757]" : "border-[var(--border)] text-[var(--text)]"}`}
    >
      <Icon className="h-3.5 w-3.5" />{children}
    </button>
  );
}

function ChargerPanel({ charger, onClose, onDirections, addTo }: { charger: Charger; onClose: () => void; onDirections: () => void; addTo?: () => void }) {
  return (
    <div className="pb-4">
      <PanelHeader title={charger.name} detail={charger.operator !== charger.name ? charger.operator : null} onClose={onClose} />
      <div className="flex gap-2 px-4 pt-3">
        <PrimaryButton icon={Navigation} onClick={onDirections}>Directions</PrimaryButton>
        {addTo && (
          <button type="button" onClick={addTo} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
            <Plus className="h-4 w-4" />Add stop
          </button>
        )}
      </div>
      <dl className="space-y-1.5 px-4 pt-3 text-sm">
        {charger.sockets.length === 0 && <p className="text-[var(--text-muted)]">Plug types aren't recorded for this station.</p>}
        {charger.sockets.map((s) => (
          <div key={s.type} className="flex justify-between gap-3">
            <dt className="text-[var(--text)]">{s.type}{s.count ? ` × ${s.count}` : ""}</dt>
            <dd className="text-[var(--text-muted)]">{s.kw ? `${s.kw} kW` : ""}</dd>
          </div>
        ))}
        {charger.hours && <div className="flex justify-between gap-3"><dt className="text-[var(--text-muted)]">Hours</dt><dd className="text-right text-[var(--text)]">{charger.hours}</dd></div>}
        {charger.fee && <div className="flex justify-between gap-3"><dt className="text-[var(--text-muted)]">Costs money</dt><dd className="text-[var(--text)]">{charger.fee === "no" ? "No" : charger.fee === "yes" ? "Yes" : charger.fee}</dd></div>}
      </dl>
      <p className="px-4 pt-3 text-xs text-[var(--text-muted)]">Whether it's free right now isn't known.</p>
    </div>
  );
}

function SortableStop({ stop, index, total, onRemove }: { stop: StopRow; index: number; total: number; onRemove?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stop.key });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex items-center gap-2 bg-[var(--surface)] py-0.5">
      <button type="button" aria-label={`Move ${stop.name}`} className="cursor-grab touch-none text-[var(--text-muted)]" {...attributes} {...listeners}>
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#D97757] text-[11px] font-semibold text-white">{String.fromCharCode(65 + index)}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{stop.name}</span>
      {total > 2 && onRemove && <SmallIcon label={`Remove ${stop.name}`} onClick={onRemove}><X className="h-4 w-4" /></SmallIcon>}
    </li>
  );
}

/** What can be looked for, as a row of small buttons. */
function NearbyChips({ on, onPick }: { on: string | null; onPick: (id: string | null) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {NEARBY.map((c) => (
        <Chip key={c.id} on={on === c.id} onClick={() => onPick(on === c.id ? null : c.id)}>{c.label}</Chip>
      ))}
    </div>
  );
}

/** Fuel, food and so on around you, closest first. */
function NearbyPanel({ centre, onShow, onMarks }: { centre: () => { lat: number; lon: number } | null; onShow: (r: SearchResult) => void; onMarks: (rows: SearchResult[]) => void }) {
  const [category, setCategory] = useState<string | null>(null);
  const [at, setAt] = useState<{ lat: number; lon: number } | null>(null);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["maps-nearby", category, at?.lat, at?.lon],
    queryFn: () => mapsApi.nearby(category!, at!.lat, at!.lon),
    enabled: !!category && !!at,
    staleTime: 300_000,
  });
  useEffect(() => onMarks(category ? (data ?? []) : []), [category, data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onMarks([]), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-3 pb-2">
      <NearbyChips on={category} onPick={(id) => {
        setAt(centre());
        setCategory(id);
      }} />
      {category && (
        <div className="-mx-3 mt-1">
          {isFetching && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Looking nearby…</p>}
          {isError && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Couldn't look that up.</p>}
          {!isFetching && !isError && data?.length === 0 && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Nothing close to here.</p>}
          {(data ?? []).slice(0, 8).map((r, i) => (
            <button key={i} type="button" onClick={() => onShow(r)} className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-[var(--hover)]">
              <span className="min-w-0">
                <span className="block truncate text-sm text-[var(--text)]">{r.name}</span>
                {r.address && <span className="block truncate text-xs text-[var(--text-muted)]">{r.address}</span>}
              </span>
              {r.distance_m != null && <span className="shrink-0 text-xs text-[var(--text-muted)]">{formatKm(r.distance_m / 1000)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What's on the way, with how long stopping there adds. */
function OnTheWay({ route, stops, mode, onAdd, onMarks }: { route: Route; stops: StopRow[]; mode: Mode; onAdd: (r: SearchResult) => void; onMarks: (rows: SearchResult[]) => void }) {
  const [category, setCategory] = useState<string | null>(null);
  const shapes = route.legs.map((l) => l.shape);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["maps-on-the-way", category, shapes.join("|").length, stops[0]?.lat, stops[stops.length - 1]?.lat],
    queryFn: () => mapsApi.nearbyAlong(category!, shapes, stops[0], stops[stops.length - 1], mode),
    enabled: !!category,
    staleTime: 300_000,
  });
  useEffect(() => onMarks(category ? (data ?? []) : []), [category, data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onMarks([]), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="px-4 pt-3">
      <p className="mb-1.5 text-xs text-[var(--text-muted)]">Or stop on the way</p>
      <NearbyChips on={category} onPick={setCategory} />
      {category && (
        <div className="-mx-4 mt-1">
          {isFetching && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Looking along your route…</p>}
          {isError && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Couldn't look that up.</p>}
          {!isFetching && !isError && data?.length === 0 && <p className="px-4 py-2 text-xs text-[var(--text-muted)]">Nothing close to this route.</p>}
          {(data ?? []).map((r, i) => (
            <button key={i} type="button" onClick={() => {
              setCategory(null);
              onAdd(r);
            }} className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-[var(--hover)]">
              <span className="min-w-0">
                <span className="block truncate text-sm text-[var(--text)]">{r.name}</span>
                {r.address && <span className="block truncate text-xs text-[var(--text-muted)]">{r.address}</span>}
              </span>
              {r.adds_seconds != null && (
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{r.adds_seconds < 60 ? "No extra time" : `+${formatDuration(r.adds_seconds)}`}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutePanel(p: {
  via: { lat: number; lon: number; name: string }[];
  pickingVia: boolean;
  onPickVia: (on: boolean) => void;
  onRemoveVia: (index: number) => void;
  onMarks: (rows: SearchResult[]) => void;
  onAddOnWay: (r: SearchResult) => void;
  stops: StopRow[];
  mode: Mode;
  setMode: (m: Mode) => void;
  avoid: { tolls: boolean; highways: boolean; ferries: boolean };
  setAvoid: (a: { tolls: boolean; highways: boolean; ferries: boolean }) => void;
  routes: Route[];
  selected: number;
  setSelected: (i: number) => void;
  routing: boolean;
  error: string | null;
  adding: boolean;
  setAdding: (v: boolean) => void;
  results?: SearchResult[];
  query: string;
  setQuery: (q: string) => void;
  onClose: () => void;
  onChange: (rows: StopRow[]) => void;
  onBestOrder: () => void;
  onPrefer: () => void;
  onStopPreferring: (id: string) => void;
  onStart: () => void;
  onAddStop: (s: Spot) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [showSteps, setShowSteps] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const route = p.routes[p.selected];
  const avoiding = Object.values(p.avoid).filter(Boolean).length;
  const drop = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = p.stops.findIndex((s) => s.key === e.active.id);
    const to = p.stops.findIndex((s) => s.key === e.over!.id);
    p.onChange(arrayMove(p.stops, from, to));
  };
  // Adding a stop is the whole panel: what you type, and what it found, above the keyboard.
  if (p.adding) {
    return (
      <div className="pb-4">
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-[var(--surface)] px-3 pb-1 pt-2">
          <SmallIcon label="Back to the route" onClick={() => {
            p.setQuery("");
            p.setAdding(false);
          }}><ArrowLeft className="h-4 w-4" /></SmallIcon>
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] px-2">
            <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
            <input autoFocus value={p.query} onChange={(e) => p.setQuery(e.target.value)} placeholder={p.stops.length === 1 ? "Start from where?" : "Add a stop"} aria-label="Add a stop" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
          </div>
        </div>
        {p.query.trim().length > 1 ? (
          (p.results ?? []).slice(0, 8).map((r, i) => <ResultRow key={i} result={r} onPick={() => p.onAddStop(r)} />)
        ) : route && p.mode !== "walk" && (
          <OnTheWay route={route} stops={p.stops} mode={p.mode} onMarks={p.onMarks} onAdd={(r) => {
            p.onAddOnWay(r);
            p.setAdding(false);
          }} />
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-3 pt-1 md:pt-3">
        <SmallIcon label="Back" onClick={p.onClose}><ArrowLeft className="h-4 w-4" /></SmallIcon>
        <div role="radiogroup" aria-label="How you're travelling" className="flex flex-1 gap-1">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={p.mode === m.id} onClick={() => p.setMode(m.id)} className={`inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${p.mode === m.id ? "bg-[var(--hover)] font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`}>
              <m.icon className="h-4 w-4" />{m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop}>
          <SortableContext items={p.stops.map((s) => s.key)} strategy={verticalListSortingStrategy}>
            <ul>
              {p.stops.map((s, i) => (
                <SortableStop key={s.key} stop={s} index={i} total={p.stops.length} onRemove={() => p.onChange(p.stops.filter((x) => x.key !== s.key))} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        {p.via.map((v, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-xs text-[var(--text)]">
            <span className="min-w-0 truncate">Via {v.name}</span>
            <SmallIcon label={`Stop going via ${v.name}`} onClick={() => p.onRemoveVia(i)}><X className="h-3.5 w-3.5" /></SmallIcon>
          </div>
        ))}
        <div className="mt-1 flex flex-wrap gap-2">
          {p.stops.length < 20 && <SaveButton icon={Plus} onClick={() => p.setAdding(true)}>Add stop</SaveButton>}
          {p.stops.length > 3 && <SaveButton icon={Navigation} onClick={p.onBestOrder}>Best order</SaveButton>}
          {p.mode !== "walk" && (
            <SaveButton icon={SlidersHorizontal} on={avoiding > 0} onClick={() => setShowOptions((v) => !v)}>
              {avoiding > 0 ? `Options (${avoiding})` : "Options"}
            </SaveButton>
          )}
        </div>
      </div>

      {showOptions && p.mode !== "walk" && (
        <div className="space-y-2 px-4 pt-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text)]">
            {([["tolls", "Avoid tolls"], ...(p.mode === "drive" ? [["highways", "Avoid highways"]] : []), ["ferries", "Avoid ferries"]] as [keyof typeof p.avoid, string][]).map(([key, label]) => (
              <label key={key} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={p.avoid[key]} onChange={(e) => p.setAvoid({ ...p.avoid, [key]: e.target.checked })} />{label}
              </label>
            ))}
          </div>
          {p.stops.length === 2 && (
            <div className="flex flex-wrap items-center gap-2">
              {p.pickingVia ? (
                <div className="flex items-center gap-2 text-xs text-[var(--accent-text)]">
                  <span>Tap the road you want to go along.</span>
                  <button type="button" onClick={() => p.onPickVia(false)} className="underline">Cancel</button>
                </div>
              ) : p.via.length < 5 && (
                <SaveButton icon={MapPin} onClick={() => p.onPickVia(true)}>Go via a road</SaveButton>
              )}
              {route && !p.routing && (route.preferred ? (
                <button type="button" onClick={() => p.onStopPreferring(route.preferred!.id)} className="text-xs text-[var(--text-muted)] hover:underline">Stop using this as your usual way</button>
              ) : (
                <SaveButton icon={RouteIcon} onClick={p.onPrefer}>Always go this way</SaveButton>
              ))}
            </div>
          )}
        </div>
      )}

      {p.routing && <p className="flex items-center gap-2 px-4 pt-3 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Finding the way…</p>}
      {p.error && <p className="px-4 pt-3 text-sm text-[var(--danger,#c0392b)]">{p.error}</p>}

      {!p.routing && p.routes.length > 0 && (
        <ul className="pt-2">
          {p.routes.map((r, i) => (
            <li key={i}>
              <button type="button" onClick={() => p.setSelected(i)} aria-pressed={i === p.selected} className={`flex w-full items-center justify-between gap-3 px-4 py-1.5 text-left ${i === p.selected ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]"}`}>
                <span className="min-w-0">
                  <span className="text-[15px] font-semibold text-[var(--text)]">{formatDuration(routeSeconds(r))}</span>
                  <span className="ml-2 text-sm text-[var(--text-muted)]">{formatKm(r.km)}</span>
                  {r.avoids?.length ? <span className="block text-xs font-medium text-[#2F9E6E]">Goes around a closed road: {r.avoids.join(", ")}</span> : null}
                  {r.incidents?.some((i) => i.closed) && <span className="block text-xs font-medium text-[#C62828]">Road closed on this way</span>}
                  {r.preferred && <span className="block text-xs font-medium text-[#D97757]">Your usual way{(r.slower_seconds ?? 0) >= 60 ? `, ${formatDuration(r.slower_seconds ?? 0)} slower today` : ""}</span>}
                  <span className="block truncate text-xs text-[var(--text-muted)]">
                    {[r.via_name && `via ${r.via_name}`, r.toll && "Tolls", r.ferry && "Ferry"].filter(Boolean).join(" · ")}
                    {trafficLine(r) && (
                      <span className={(r.traffic?.adds_seconds ?? 0) >= 60 ? "text-[#D9730D] dark:text-[#F2B01E]" : undefined}>
                        {r.via_name || r.toll || r.ferry ? " · " : ""}{trafficLine(r)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {route && !p.routing && (
        <>
          {!route.traffic && <p className="px-4 pt-1 text-[11px] text-[var(--text-muted)]">Times come from road speeds, without live traffic.</p>}
          {(route.incidents?.length ?? 0) > 0 && (
            <ul className="px-4 pt-1">
              {route.incidents!.slice(0, 3).map((i) => (
                <li key={i.id} className="flex gap-2 py-0.5 text-xs">
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-bold text-white ${i.closed || i.category === 1 ? "bg-[#C62828]" : "bg-[#EF8A1A]"}`}>!</span>
                  <span className="min-w-0 text-[var(--text)]">
                    {i.label}{i.from ? ` on ${i.from}` : ""}, {formatKm(i.along_km)} ahead{i.delay_seconds >= 60 ? `, adds ${formatDuration(i.delay_seconds)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {showSteps && (
            <ol className="px-4 pt-3 text-sm">
              {route.legs.flatMap((l, li) => l.steps.map((s, si) => (
                <li key={`${li}-${si}`} className="flex justify-between gap-3 border-b border-[var(--border)] py-2 last:border-0">
                  <span className="text-[var(--text)]">{s.text}</span>
                  {s.km > 0 && <span className="shrink-0 text-xs text-[var(--text-muted)]">{formatKm(s.km)}</span>}
                </li>
              )))}
            </ol>
          )}
          {/* Always there: everything above scrolls under it. */}
          <div className="sticky bottom-0 flex gap-2 bg-[var(--surface)] px-4 pb-3 pt-2">
            <PrimaryButton icon={Navigation} onClick={p.onStart}>Start</PrimaryButton>
            <button type="button" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps} className="inline-flex h-10 items-center gap-1 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
              Steps{showSteps ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
