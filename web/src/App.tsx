import { MapCanvas } from './map/MapCanvas';
import { useLineaStream } from './data/stream';
import { StatusIsland } from './ui/StatusIsland';
import { PolicyToggle } from './ui/PolicyToggle';
import { ImpactStrip } from './ui/ImpactStrip';
import { ActivityFeed } from './ui/ActivityFeed';
import { LiveCallCard } from './ui/LiveCallCard';
import { ImpactCard } from './ui/ImpactCard';
import { EndCard } from './ui/EndCard';
import { Hotkeys } from './ui/Hotkeys';
import { DebugOverlay, MapLegend, Toast } from './ui/Overlays';

export function App() {
  useLineaStream();
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: 'var(--bg)' }}>
      <MapCanvas />
      <PolicyToggle />
      <StatusIsland />
      <ImpactStrip />
      <ActivityFeed />
      <MapLegend />
      <LiveCallCard />
      <ImpactCard />
      <Toast />
      <DebugOverlay />
      <EndCard />
      <Hotkeys />
    </div>
  );
}
