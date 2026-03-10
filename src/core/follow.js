/**
 * core/follow.js
 * Entity-follow camera using Cesium's native trackedEntity + viewFrom.
 *
 * viewer.trackedEntity keeps the entity centred while still allowing the user
 * to orbit (right-drag), zoom (scroll), and pitch freely around it.
 * The only way to exit follow mode is via the UNFOLLOW button — not by
 * orbiting or zooming, which are natural interactions while following.
 *
 * Usage:
 *   followEntity(viewer, entity, { label, type, onStop })
 *   stopFollow()
 *   isFollowing()    → bool
 *   followingLabel() → string | null
 */

import * as Cesium from 'cesium';

// ── Config ────────────────────────────────────────────────────────────────────

// viewFrom: camera offset (ENU metres) from entity when follow starts.
// x = east offset, y = north offset (negative = behind), z = up offset.
const VIEW_FROM = {
  flight:    new Cesium.Cartesian3(0, -2_000,    900),  // closer behind & above
  satellite: new Cesium.Cartesian3(0,      0, 600_000), // straight above
  vehicle:   new Cesium.Cartesian3(0, -1_000,    600),
  camera:    new Cesium.Cartesian3(0,      0,    300),
  default:   new Cesium.Cartesian3(0, -6_000,  2_000),
};

// ── State ─────────────────────────────────────────────────────────────────────

let _viewer = null;
let _entity = null;
let _label  = '';
let _type   = 'default';
let _onStop = null;
let _active = false;
let _preFollowView = null;
let _preFollowControls = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Begin following an entity.
 * @param {Cesium.Viewer}  viewer
 * @param {Cesium.Entity}  entity
 * @param {object}         opts
 * @param {string}         opts.label   — display name shown in HUD
 * @param {string}         opts.type    — 'flight' | 'satellite' | 'vehicle' | 'camera'
 * @param {function}       opts.onStop  — called when follow ends for any reason
 */
export function followEntity(viewer, entity, opts = {}) {
  if (!entity?.position) {
    console.warn('[Follow] Entity has no position — cannot follow.');
    return;
  }

  // Clean up any prior follow silently
  _cleanup(true);

  _viewer = viewer;
  _entity = entity;
  _label  = opts.label ?? (typeof entity.id === 'string' ? entity.id : 'Unknown');
  _type   = opts.type  ?? 'default';
  _onStop = opts.onStop ?? null;
  _active = true;
  _preFollowView = _captureCameraView(viewer);
  _preFollowControls = _captureControlMappings(viewer);
  _applyFollowControlMappings(viewer);

  console.log(`[Follow] → ${_label} (${_type})`);

  // Set viewFrom so Cesium knows where to position the camera relative to entity
  const offset = VIEW_FROM[_type] ?? VIEW_FROM.default;
  entity.viewFrom = new Cesium.ConstantProperty(offset);

  // Fly smoothly to the entity first, then hand off to trackedEntity
  const initPos = _getEntityPosition(entity);
  if (initPos) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.add(
        initPos,
        new Cesium.Cartesian3(0, 0, Cesium.Cartesian3.magnitude(offset) * 0.4),
        new Cesium.Cartesian3()
      ),
      duration: 1.6,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => {
        if (_active && _entity === entity) {
          viewer.trackedEntity = entity;
        }
      },
    });
  } else {
    viewer.trackedEntity = entity;
  }

  window.dispatchEvent(new CustomEvent('worldview:follow', {
    detail: { label: _label, type: _type, entity }
  }));
}

/**
 * Stop following.
 * @param {boolean} [silent] suppress the 'worldview:unfollow' event
 * @param {boolean} [restorePreviousView] when true, fly back to pre-follow camera view
 */
export function stopFollow(silent = false, restorePreviousView = false) {
  if (!_active && !_entity) return;
  _cleanup(silent, restorePreviousView);
}

/** Returns true if currently locked onto an entity. */
export function isFollowing() { return _active && _entity !== null; }

/** Returns the display label of the followed entity, or null. */
export function followingLabel() { return _active ? _label : null; }

// ── Internal ──────────────────────────────────────────────────────────────────

function _cleanup(silent, restorePreviousView = false) {
  const prevViewer = _viewer;
  const wasActive  = _active;
  const prevLabel  = _label;
  const prevType   = _type;
  const cb         = _onStop;
  const prevView   = _preFollowView;
  const prevCtrl   = _preFollowControls;

  _active = false;
  _entity = null;
  _label  = '';
  _type   = 'default';
  _onStop = null;
  _preFollowView = null;
  _preFollowControls = null;

  if (prevViewer) {
    // Release trackedEntity lock — restores full manual camera control
    prevViewer.trackedEntity = undefined;
    _restoreControlMappings(prevViewer, prevCtrl);
    _viewer = null;

    if (restorePreviousView && prevView) {
      prevViewer.camera.flyTo({
        destination: Cesium.Cartesian3.clone(prevView.destination),
        orientation: {
          heading: prevView.heading,
          pitch:   prevView.pitch,
          roll:    prevView.roll,
        },
        duration: 1.2,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      });
    }
  }

  if (!silent && wasActive && prevLabel) {
    console.log(`[Follow] ✕ ${prevLabel}`);
    window.dispatchEvent(new CustomEvent('worldview:unfollow', {
      detail: { label: prevLabel, type: prevType }
    }));
  }

  cb?.();
}

function _getEntityPosition(entity) {
  if (!entity?.position) return null;
  try { return entity.position.getValue(Cesium.JulianDate.now()) ?? null; }
  catch { return null; }
}

function _captureCameraView(viewer) {
  if (!viewer?.camera) return null;
  return {
    destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
  };
}

function _captureControlMappings(viewer) {
  const ctrl = viewer?.scene?.screenSpaceCameraController;
  if (!ctrl) return null;
  return {
    rotateEventTypes: _cloneEventTypes(ctrl.rotateEventTypes),
    tiltEventTypes: _cloneEventTypes(ctrl.tiltEventTypes),
    lookEventTypes: _cloneEventTypes(ctrl.lookEventTypes),
    translateEventTypes: _cloneEventTypes(ctrl.translateEventTypes),
  };
}

function _applyFollowControlMappings(viewer) {
  const ctrl = viewer?.scene?.screenSpaceCameraController;
  if (!ctrl) return;

  // While tracking, allow easy orbit around target with either drag button.
  ctrl.rotateEventTypes = [
    Cesium.CameraEventType.LEFT_DRAG,
    Cesium.CameraEventType.RIGHT_DRAG,
  ];
  ctrl.tiltEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
  ];
  ctrl.lookEventTypes = [
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
  ];
  ctrl.translateEventTypes = [
    Cesium.CameraEventType.MIDDLE_DRAG,
  ];
}

function _restoreControlMappings(viewer, saved) {
  const ctrl = viewer?.scene?.screenSpaceCameraController;
  if (!ctrl || !saved) return;
  ctrl.rotateEventTypes = _cloneEventTypes(saved.rotateEventTypes);
  ctrl.tiltEventTypes = _cloneEventTypes(saved.tiltEventTypes);
  ctrl.lookEventTypes = _cloneEventTypes(saved.lookEventTypes);
  ctrl.translateEventTypes = _cloneEventTypes(saved.translateEventTypes);
}

function _cloneEventTypes(v) {
  if (!v) return v;
  if (Array.isArray(v)) {
    return v.map(e => (typeof e === 'object' && e !== null ? { ...e } : e));
  }
  return (typeof v === 'object' && v !== null) ? { ...v } : v;
}
