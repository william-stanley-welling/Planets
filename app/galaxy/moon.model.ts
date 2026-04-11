import * as THREE from 'three';
import { MoonConfig, OrbitingBody } from './celestial.model';

// ~AI PROMPT~ Re-export MoonConfig for convenience? Does this have to be here?
export { MoonConfig };

export enum LunarPhase {
  NEW_MOON = 'New Moon',
  WAXING_CRESCENT = 'Waxing Crescent',
  FIRST_QUARTER = 'First Quarter',
  WAXING_GIBBOUS = 'Waxing Gibbous',
  FULL_MOON = 'Full Moon',
  WANING_GIBBOUS = 'Waning Gibbous',
  LAST_QUARTER = 'Last Quarter',
  WANING_CRESCENT = 'Waning Crescent',
}

/* ~AI PROMPT~: expose this on dashboard for selected moon. If it is hardcoded to Earth's moon, fix to be generalizable for all planets moons. Also, add these somewhere in HTML.

Here are more emoji-style options you can use for those space controls: 🌍 🌎 🌏 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌙 🌚 🌛 🌜 🌞 🌠 🪐 🔭

For a UI button like your example, the closest replacements are:

🌍 for Earth or planet.

🌙 for moon or lunar.

🪐 for a generic planet.

🔭 for astronomy or viewing.

🌠 for orbit / space vibe.

🌚 or 🌛 / 🌜 for moon-state variants.

If you want a compact set for toggles, these work well together:

🌍 Planet Orbits.

🌙 Moon Orbits.

🪐 Planet Mode.

🔘 Select.

⚙️ Settings.

🔭 View Orbit.

I’ll group these into:

🔁 Timeline / Scrubbing
🌌 Events / Smart Time
🎥 Cinematic / Motion
⏱ Core Time Controls
⚡ Advanced / UX polish

All icons are HTML-compatible (Unicode + optional CSS class usage).

🔁 TIMELINE / SCRUB BAR ICONS
Icon	HTML	Meaning
🔁	&#x1F501;	Loop timeline
⏮	&#x23EE;	Jump to start
⏭	&#x23ED;	Jump to end
⏪	&#x23EA;	Rewind (fast backward)
⏩	&#x23E9;	Fast forward
⏯	&#x23EF;	Play/Pause toggle
🧭	&#x1F9ED;	Timeline navigation
📍	&#x1F4CD;	Timeline marker
📌	&#x1F4CC;	Pinned moment
🧵	&#x1F9F5;	Time thread
📏	&#x1F4CF;	Time scale
🪄	&#x1FA84;	Smooth scrub
🎚	&#x1F39A;	Scrub slider
🎛	&#x1F39B;	Timeline control panel
🌌 AUTO-SLOW / EVENT-AWARE ICONS
Icon	HTML	Meaning
🌌	&#x1F30C;	Cosmic events
🌠	&#x1F320;	Passing events
✨	&#x2728;	Highlight moment
🔍	&#x1F50D;	Focus / zoom event
🎯	&#x1F3AF;	Target event
⚠️	&#x26A0;	Important event
🛰	&#x1F6F0;	Orbital interaction
🪐	&#x1FA90;	Planetary alignment
🌕	&#x1F315;	Phase event
🌗	&#x1F317;	Transition phase
🌑	&#x1F311;	Eclipse / dark event
☄️	&#x2604;	Flyby / comet
🔭	&#x1F52D;	Observational moment
🧲	&#x1F9F2;	Gravity interaction
📡	&#x1F4E1;	Signal / detection
⛓	&#x26D3;	Orbital lock
🌀	&#x1F300;	Dynamic system event
🎥 CINEMATIC / TIME RAMP ICONS
Icon	HTML	Meaning
🎥	&#x1F3A5;	Cinematic mode
🎬	&#x1F3AC;	Scene / shot
🎞	&#x1F39E;	Timeline playback
🧊	&#x1F9CA;	Freeze frame
🫧	&#x1FAE7;	Smooth easing
🌊	&#x1F30A;	Flow / easing curve
📈	&#x1F4C8;	Speed ramp up
📉	&#x1F4C9;	Slow down
🎢	&#x1F3A2;	Dramatic ramp
🪂	&#x1FA82;	Slow descent
🚀	&#x1F680;	Acceleration burst
🐢	&#x1F422;	Slow motion
⚡	&#x26A1;	Sudden speed change
🧭	&#x1F9ED;	Guided cinematic path
🧿	&#x1F9FF;	Focus lock
🎯	&#x1F3AF;	Camera target
⏱ CORE TIME CONTROL ICONS
Icon	HTML	Meaning
⏱	&#x23F1;	Time control
⏰	&#x23F0;	Scheduled event
⌛	&#x231B;	Waiting / loading
⏳	&#x23F3;	Time passing
🕒	&#x1F552;	Clock
🕰	&#x1F570;	Simulation time
🔄	&#x1F504;	Reset / restart
🔃	&#x1F503;	Refresh
⏸	&#x23F8;	Pause
▶	&#x25B6;	Play
◀	&#x25C0;	Reverse
⏹	&#x23F9;	Stop
⚡ ADVANCED / UX POLISH ICONS
Icon	HTML	Meaning
🧠	&#x1F9E0;	Smart system
🤖	&#x1F916;	Auto behavior
📊	&#x1F4CA;	Time analytics
📉	&#x1F4C9;	Deceleration
📈	&#x1F4C8;	Acceleration
🧮	&#x1F9EE;	Computation
🧬	&#x1F9EC;	System evolution
🧱	&#x1F9F1;	Keyframe
🪜	&#x1FA9C;	Step progression
🧭	&#x1F9ED;	Navigation
🔗	&#x1F517;	Linked timeline
🧩	&#x1F9E9;	Modular events
🎯 RECOMMENDED COMBINATIONS (Best UX)
🔁 Timeline Scrubber Label
<span>🔁 Timeline</span>
🌌 Smart Event Mode
<button>🌌 Auto Events</button>
🎥 Cinematic Mode
<button>🎥 Cinematic</button>
🚀 Speed Boost
<button>🚀 Boost</button>
🐢 Slow Motion
<button>🐢 Slow</button>
🚀 PRO-LEVEL UX SET (what I recommend you actually use)

Use this minimal, clean set:

🔁 ⏪ ⏸ ▶ ⏩  
🌌 🎯 ✨  
🎥 📈 📉  
🚀 🐢 ⚡

That gives you:

Full control
Clear meaning
Zero clutter

*/

export function lunarPhaseFromAngle(phaseAngleRad: number): LunarPhase {
  const a = ((phaseAngleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const deg = (a * 180) / Math.PI;
  if (deg < 22.5 || deg >= 337.5) return LunarPhase.NEW_MOON;
  if (deg < 67.5) return LunarPhase.WAXING_CRESCENT;
  if (deg < 112.5) return LunarPhase.FIRST_QUARTER;
  if (deg < 157.5) return LunarPhase.WAXING_GIBBOUS;
  if (deg < 202.5) return LunarPhase.FULL_MOON;
  if (deg < 247.5) return LunarPhase.WANING_GIBBOUS;
  if (deg < 292.5) return LunarPhase.LAST_QUARTER;
  return LunarPhase.WANING_CRESCENT;
}

export class Moon extends OrbitingBody {
  readonly resource?: string;

  constructor(config: MoonConfig) {
    super(config);
    this.resource = config.resource;
    if (!config.au && !config.relativeAu) {
      // console.warn(`Moon "${config.name}" has no au or relativeAu — default radius used.`);
    }
  }

  getLunarPhase(starWorldPosition: THREE.Vector3 = new THREE.Vector3()): LunarPhase {
    const moonWorld = new THREE.Vector3();
    this.group.getWorldPosition(moonWorld);
    const toStar = starWorldPosition.clone().sub(moonWorld).normalize();
    const phaseAngle = Math.atan2(toStar.z, toStar.x);
    return lunarPhaseFromAngle(phaseAngle);
  }
}
