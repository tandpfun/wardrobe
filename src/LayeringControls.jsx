export function LayeringControls({ value, onChange, disabled = false, action, notice }) {
  if (["accessories_up", "lowerbody", "shoes"].includes(value.part)) return null;

  return (
    <fieldset className="layering-controls" disabled={disabled}>
      <legend>Ways to wear</legend>
      <div className="layering-row">
        <label className="layering-checkbox">
          <input type="checkbox" checked={value.canLayer === true} onChange={(event) => onChange({ ...value, canLayer: event.target.checked, layeringSource: "manual" })} />
          <span>Can wear as a layer</span>
        </label>
        {action}
      </div>
      <p>Layer over a T-shirt or hoodie.</p>
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  );
}
