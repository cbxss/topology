// Immutable routing inputs are independent of mutable per-request execution state.
function freezeData(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
function attachContext(msg, context, traffic, origin = msg.source, rootId = msg.id) {
  msg.context = freezeData(structuredClone(context));
  msg.traffic = traffic ?? null;
  msg.origin = origin;
  msg.rootId = rootId;
  return msg;
}
function envelopeOf(msg, parentSpan) {
  return freezeData(structuredClone({ context: msg.context, traffic: msg.traffic, origin: msg.origin, rootId: msg.rootId, parentId: msg.id, endpoint: msg.endpoint, records: msg.records, draws: msg.draws, parentSpan }));
}
function inheritEnvelope(msg, envelope) {
  attachContext(msg, envelope.context, envelope.traffic, envelope.origin, envelope.rootId);
  msg.parentId = envelope.parentId;
  msg.endpoint = envelope.endpoint;
  if (envelope.records) msg.records = structuredClone(envelope.records);
  if (envelope.draws) msg.draws = structuredClone(envelope.draws);
  return msg;
}
export { attachContext, envelopeOf, inheritEnvelope };
