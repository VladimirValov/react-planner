import {List, Map} from 'immutable';

import {
  SELECT_TOOL_DRAWING_LINE,
  BEGIN_DRAWING_LINE,
  UPDATE_DRAWING_LINE,
  END_DRAWING_LINE,
  BEGIN_DRAGGING_LINE,
  UPDATE_DRAGGING_LINE,
  END_DRAGGING_LINE,
  SELECT_LINE,
  MODE_IDLE,
  MODE_WAITING_DRAWING_LINE,
  MODE_DRAWING_LINE,
  MODE_DRAGGING_LINE
} from '../constants';

import * as Geometry from '../utils/geometry';
import {
  addLine,
  replaceLineVertex,
  removeLine,
  select,
  unselect,
  addLineAvoidingIntersections,
  unselectAll,
  detectAndUpdateAreas, mergeEqualsVertices,
} from '../utils/layer-operations';
import {nearestSnap, addPointSnap, addLineSnap, addLineSegmentSnap} from '../utils/snap';
import {sceneSnapElements} from '../utils/snap-scene';
import {samePoints} from "../utils/geometry";

export default function (state, action) {
  switch (action.type) {
    case SELECT_TOOL_DRAWING_LINE:
      return selectToolDrawingLine(state, action.sceneComponentType);

    case BEGIN_DRAWING_LINE:
      return beginDrawingLine(state, action.layerID, action.x, action.y);

    case UPDATE_DRAWING_LINE:
      return updateDrawingLine(state, action.x, action.y);

    case END_DRAWING_LINE:
      return endDrawingLine(state, action.x, action.y);

    case BEGIN_DRAGGING_LINE:
      return beginDraggingLine(state, action.layerID, action.lineID, action.x, action.y);

    case UPDATE_DRAGGING_LINE:
      return updateDraggingLine(state, action.x, action.y);

    case END_DRAGGING_LINE:
      return endDraggingLine(state, action.x, action.y);

    case SELECT_LINE:
      return selectLine(state, action.layerID, action.lineID);

    default:
      return state;
  }
}

function selectToolDrawingLine(state, sceneComponentType) {
  return state.merge({
    mode: MODE_WAITING_DRAWING_LINE,
    drawingSupport: Map({
      type: sceneComponentType
    })
  });
}

/** lines operations **/
function beginDrawingLine(state, layerID, x, y) {
  let catalog = state.catalog;

  let snapElements = sceneSnapElements(state.scene, new List(), state.snapMask);
  let snap = null;

  if (state.snapMask && !state.snapMask.isEmpty()) {
    snap = nearestSnap(snapElements, x, y, state.snapMask);
    if (snap) ({x, y} = snap.point);

    snapElements = snapElements.withMutations(snapElements => {
      let a, b, c;
      ({a, b, c} = Geometry.horizontalLine(y));
      addLineSnap(snapElements, a, b, c, 10, 3, null);
      ({a, b, c} = Geometry.verticalLine(x));
      addLineSnap(snapElements, a, b, c, 10, 3, null);
    });
  }

  let drawingSupport = state.get('drawingSupport').set('layerID', layerID);
  let scene = state.scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {
    unselectAll(layer);
    let {line} = addLine(layer, drawingSupport.get('type'), x, y, x, y, catalog);
    select(layer, 'lines', line.id);
    select(layer, 'vertices', line.vertices.get(0));
    select(layer, 'vertices', line.vertices.get(1));
  }));

  return state.merge({
    mode: MODE_DRAWING_LINE,
    scene,
    snapElements,
    activeSnapElement: snap ? snap.snap : null,
    drawingSupport
  });
}

function updateDrawingLine(state, x, y) {

  let snap = null;
  if (state.snapMask && !state.snapMask.isEmpty()) {
    snap = nearestSnap(state.snapElements, x, y, state.snapMask);
    if (snap) ({x, y} = snap.point);
  }

  let layerID = state.getIn(['drawingSupport', 'layerID']);
  let scene = state.scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {
    let lineID = layer.getIn(['selected', 'lines']).first();
    let vertex;
    ({layer, vertex} = replaceLineVertex(layer, lineID, 1, x, y));
    select(layer, 'vertices', vertex.id);
    return layer;
  }));

  return state.merge({
    scene,
    activeSnapElement: snap ? snap.snap : null,
  });
}

function endDrawingLine(state, x, y) {

  let catalog = state.catalog;

  if (state.snapMask && !state.snapMask.isEmpty()) {
    let snap = nearestSnap(state.snapElements, x, y, state.snapMask);
    if (snap) ({x, y} = snap.point);
  }

  let layerID = state.getIn(['drawingSupport', 'layerID']);
  let scene = state.scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {
    let lineID = layer.getIn(['selected', 'lines']).first();
    let line = layer.getIn(['lines', lineID]);
    let v0 = layer.vertices.get(line.vertices.get(0));

    unselect(layer, 'lines', lineID);
    unselect(layer, 'vertices', line.vertices.get(0));
    unselect(layer, 'vertices', line.vertices.get(1));
    removeLine(layer, lineID);
    addLineAvoidingIntersections(layer, line.type, v0.x, v0.y, x, y, catalog);
    detectAndUpdateAreas(layer, catalog);
  }));

  return state.merge({
    mode: MODE_WAITING_DRAWING_LINE,
    scene,
    snapElements: new List(),
    activeSnapElement: null,
    sceneHistory: state.sceneHistory.push(scene)
  });
}

function beginDraggingLine(state, layerID, lineID, x, y) {

  let snapElements = sceneSnapElements(state.scene, new List(), state.snapMask);

  let layer = state.scene.layers.get(layerID);
  let line = layer.lines.get(lineID);

  let vertex0 = layer.vertices.get(line.vertices.get(0));
  let vertex1 = layer.vertices.get(line.vertices.get(1));

  return state.merge({
    mode: MODE_DRAGGING_LINE,
    snapElements,
    draggingSupport: Map({
      layerID, lineID,
      startPointX: x,
      startPointY: y,
      startVertex0X: vertex0.x,
      startVertex0Y: vertex0.y,
      startVertex1X: vertex1.x,
      startVertex1Y: vertex1.y,
    })
  })
}

function updateDraggingLine(state, x, y) {

  let draggingSupport = state.draggingSupport;
  let snapElements = state.snapElements;

  let layerID = draggingSupport.get('layerID');
  let lineID = draggingSupport.get('lineID');
  let diffX = x - draggingSupport.get('startPointX');
  let diffY = y - draggingSupport.get('startPointY');
  let newVertex0X = draggingSupport.get('startVertex0X') + diffX;
  let newVertex0Y = draggingSupport.get('startVertex0Y') + diffY;
  let newVertex1X = draggingSupport.get('startVertex1X') + diffX;
  let newVertex1Y = draggingSupport.get('startVertex1Y') + diffY;


  let activeSnapElement = null;
  let curSnap0 = null, curSnap1 = null;
  if (state.snapMask && !state.snapMask.isEmpty()) {
    curSnap0 = nearestSnap(snapElements, newVertex0X, newVertex0Y, state.snapMask);
    curSnap1 = nearestSnap(snapElements, newVertex1X, newVertex1Y, state.snapMask);
  }

  let deltaX = 0, deltaY = 0;
  if (curSnap0 && curSnap1) {
    if (curSnap0.point.distance < curSnap1.point.distance) {
      deltaX = curSnap0.point.x - newVertex0X;
      deltaY = curSnap0.point.y - newVertex0Y;
      activeSnapElement = curSnap0.snap;
    } else {
      deltaX = curSnap1.point.x - newVertex1X;
      deltaY = curSnap1.point.y - newVertex1Y;
      activeSnapElement = curSnap1.snap;
    }
  } else {
    if (curSnap0) {
      deltaX = curSnap0.point.x - newVertex0X;
      deltaY = curSnap0.point.y - newVertex0Y;
      activeSnapElement = curSnap0.snap;
    }
    if (curSnap1) {
      deltaX = curSnap1.point.x - newVertex1X;
      deltaY = curSnap1.point.y - newVertex1Y;
      activeSnapElement = curSnap1.snap;
    }
  }

  newVertex0X += deltaX;
  newVertex0Y += deltaY;
  newVertex1X += deltaX;
  newVertex1Y += deltaY;

  return state.merge({
    activeSnapElement,
    scene: state.scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {
      let lineVertices = layer.getIn(['lines', lineID, 'vertices']);
      layer.updateIn(['vertices', lineVertices.get(0)], vertex => vertex.merge({x: newVertex0X, y: newVertex0Y}));
      layer.updateIn(['vertices', lineVertices.get(1)], vertex => vertex.merge({x: newVertex1X, y: newVertex1Y}));
      return layer;
    }))
  });
}

function endDraggingLine(state, x, y) {
  let catalog = state.catalog;
  let {draggingSupport} = state;
  let layerID = draggingSupport.get('layerID');
  let layer = state.scene.layers.get(layerID);
  let lineID = draggingSupport.get('lineID');
  let line = layer.lines.get(lineID);

  let vertex0 = layer.vertices.get(line.vertices.get(0));
  let vertex1 = layer.vertices.get(line.vertices.get(1));

  let maxV = Geometry.maxVertex(vertex0, vertex1);
  let minV = Geometry.minVertex(vertex0, vertex1);

  let lineLength = Geometry.verticesDistance(minV,maxV);
  let alpha = Math.atan2(maxV.y - minV.y, maxV.x - minV.x);

  let holesWithOffsetPosition = [];
  layer.lines.get(lineID).holes.forEach(holeID => {
    let hole = layer.holes.get(holeID);
    let pointOnLine = lineLength * hole.offset;

    let offsetPosition = {
      x: pointOnLine * Math.cos(alpha) + minV.x,
      y: pointOnLine * Math.sin(alpha) + minV.y
    };

    holesWithOffsetPosition.push({hole, offsetPosition});
  });

  return state.withMutations(state => {
    let scene = state.scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {

      let diffX = x - draggingSupport.get('startPointX');
      let diffY = y - draggingSupport.get('startPointY');
      let newVertex0X = draggingSupport.get('startVertex0X') + diffX;
      let newVertex0Y = draggingSupport.get('startVertex0Y') + diffY;
      let newVertex1X = draggingSupport.get('startVertex1X') + diffX;
      let newVertex1Y = draggingSupport.get('startVertex1Y') + diffY;

      if (state.snapMask && !state.snapMask.isEmpty()) {

        let curSnap0 = nearestSnap(state.snapElements, newVertex0X, newVertex0Y, state.snapMask);
        let curSnap1 = nearestSnap(state.snapElements, newVertex1X, newVertex1Y, state.snapMask);

        let deltaX = 0, deltaY = 0;
        if (curSnap0 && curSnap1) {
          if (curSnap0.point.distance < curSnap1.point.distance) {
            deltaX = curSnap0.point.x - newVertex0X;
            deltaY = curSnap0.point.y - newVertex0Y;
          } else {
            deltaX = curSnap1.point.x - newVertex1X;
            deltaY = curSnap1.point.y - newVertex1Y;
          }
        } else {
          if (curSnap0) {
            deltaX = curSnap0.point.x - newVertex0X;
            deltaY = curSnap0.point.y - newVertex0Y;
          }
          if (curSnap1) {
            deltaX = curSnap1.point.x - newVertex1X;
            deltaY = curSnap1.point.y - newVertex1Y;
          }
        }

        newVertex0X += deltaX;
        newVertex0Y += deltaY;
        newVertex1X += deltaX;
        newVertex1Y += deltaY;
      }

      mergeEqualsVertices(layer, line.vertices.get(0));
      mergeEqualsVertices(layer, line.vertices.get(1));

      removeLine(layer, lineID);

      if(!samePoints({newVertex0X, newVertex0Y}, {newVertex1X, newVertex1Y})) {
        addLineAvoidingIntersections(layer, line.type,
          newVertex0X, newVertex0Y, newVertex1X, newVertex1Y,
          catalog, line.properties, holesWithOffsetPosition);
      }

      detectAndUpdateAreas(layer, catalog);
    }));

    state.merge({
      mode: MODE_IDLE,
      scene,
      draggingSupport: null,
      activeSnapElement: null,
      snapElements: new List(),
      sceneHistory: state.sceneHistory.push(scene)
    });
  });
}

function selectLine(state, layerID, lineID) {
  let scene = state.scene;

  scene = scene.merge({
    layers: scene.layers.map(unselectAll),
    selectedLayer: layerID
  });

  scene = scene.updateIn(['layers', layerID], layer => layer.withMutations(layer => {
      let line = layer.getIn(['lines', lineID]);
      select(layer, 'lines', lineID);
      select(layer, 'vertices', line.vertices.get(0));
      select(layer, 'vertices', line.vertices.get(1));
    })
  );

  return state.merge({
    scene,
    sceneHistory: state.sceneHistory.push(scene)
  })
}
