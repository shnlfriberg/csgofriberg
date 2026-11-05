import { UploadCloud, X, CheckCircle2, ImagePlus } from 'lucide-react';
import Radar from '../../location/Radar';
import PositionCodeInput from './location/PositionCodeInput';
import { Photo } from '../../location/Components';
import type { Question, Tier } from '../../location/types';
import { useQuestionEditor, type Props } from './location/useQuestionEditor';
export default function LocationQuestionDialog({
  maps,
  question,
  captureDraft,
  captureImageId,
  pointReference,
  onClose,
  onSaved,
}: Props) {
  const { t, dialog, fileInput, sharedWorld, lockedPoint, selectedCaptureImage, mapId, setMapId, floorId, setFloorId, asset, pin, setPin, tier, setTier, point, setPoint, capturedAt, setCapturedAt, build, setBuild, source, setSource, world, setWorld, view, setView, paste, setPaste, error, setError, pointMismatch, setPointMismatch, uploading, saving, progress, dragging, setDragging, map, busy, positionVerified, setPositionVerified, mapChanged, measured, camera, converted, withinRadar, mismatch, canPublish, upload, applyPosition, save } = useQuestionEditor({ maps, question, captureDraft, captureImageId, pointReference, onClose, onSaved });
  const numberField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    readOnly = false
  ) => (
    <label>
      {label}
      <input
        className="input"
        type="number"
        step="any"
        value={value}
        disabled={busy}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
  return (
    <dialog
      ref={dialog}
      className="location-upload-dialog location-page"
      aria-labelledby="location-upload-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement;
          const status =
            (submitter?.dataset.status as Question['status']) || 'draft';
          void save(status, submitter?.dataset.next === 'true');
        }}
      >
        <header className="location-upload-header">
          <div>
            <span className="location-eyebrow">
              CS2 // {t('location.questions')}
            </span>
            <h2 id="location-upload-title">
              {t(question ? 'location.editQuestion' : 'location.newQuestion')}
            </h2>
            <p>{t('location.uploadHelp')}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="location-upload-body">
          {mapChanged && (
            <div className="location-rules-note">
              <p>{t('location.captureMapChanged')}</p>
              <label>
                <input
                  type="checkbox"
                  checked={positionVerified}
                  onChange={(e) => setPositionVerified(e.target.checked)}
                />
                {t('location.captureConfirmPosition')}
              </label>
            </div>
          )}
          {error && (
            <div role="alert" className="location-alert">
              {error}
            </div>
          )}
          {captureDraft && (
            <p className="location-rules-note">
              {captureDraft.batchName} · {captureDraft.capturePointId}
              {captureDraft.mapVersion !== map.version &&
                ` · ${t('location.captureMapChanged')}`}
            </p>
          )}
          <div className="location-upload-layout">
            <section className="location-upload-preview">
              <h3>01 · {t('location.screenshot')}</h3>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                disabled={busy}
                aria-label={t('location.upload')}
                onChange={(event) => {
                  void upload(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              {asset ? (
                <>
                  <Photo url={asset.url} />
                  <div className="location-upload-file">
                    <span>
                      <CheckCircle2 size={16} />
                      {t('location.assetUploadedShort')}
                      {asset.width && ` · ${asset.width}×${asset.height}`}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => fileInput.current?.click()}
                    >
                      {t('location.replaceImage')}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className={`location-drop-zone ${dragging ? 'dragging' : ''}`}
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    void upload(event.dataTransfer.files[0]);
                  }}
                >
                  <UploadCloud size={36} />
                  <strong>{t('location.dropImage')}</strong>
                  <span>{t('location.uploadImageLimit')}</span>
                </button>
              )}
              {uploading && (
                <div className="location-upload-progress" role="status">
                  <progress max={100} value={progress} />
                  <span>
                    {t('location.uploading')} · {progress}%
                  </span>
                </div>
              )}
              <p className="location-rules-note">
                {t('location.cropImageHelp')}
              </p>
              <h3>02 · {t('location.answerPosition')}</h3>
              {floorId ? (
                <Radar
                  map={map}
                  floorId={floorId}
                  guess={pin}
                  onChange={busy || lockedPoint ? undefined : setPin}
                  hint={lockedPoint ? t('location.sharedPinHelp') : undefined}
                />
              ) : (
                <div className="location-radar-placeholder">
                  {t('location.chooseFloor')}
                </div>
              )}
              {pin && (
                <output className="location-upload-coordinate">
                  u {pin.u.toFixed(6)} · v {pin.v.toFixed(6)}
                </output>
              )}
              <p className="muted">{t(lockedPoint ? 'location.sharedPinHelp' : 'location.coordinateHelp')}</p>
            </section>
            <section className="location-upload-fields">
              <h3>03 · {t('location.questionDetails')}</h3>
              <div className="location-form-grid">
                <label>
                  {t('location.mapName')}
                  <select
                    className="input"
                    value={mapId}
                    disabled={busy || Boolean(captureDraft) || lockedPoint}
                    onChange={(event) => {
                      const next = maps.find(
                        (item) => item.id === event.target.value
                      )!;
                      setMapId(next.id);
                      setFloorId(
                        next.floors.length === 1 ? next.floors[0].id : ''
                      );
                      setPin(null);
                      setWorld({ x: '', y: '', z: '' });
                      setPaste('');
                    }}
                  >
                    {maps.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('location.chooseFloor')}
                  <select
                    className="input"
                    required
                    value={floorId}
                    disabled={busy || Boolean(captureDraft) || lockedPoint}
                    onChange={(event) => {
                      setFloorId(event.target.value);
                      setPin(null);
                    }}
                  >
                    <option value="" disabled>
                      {t('location.chooseFloor')}
                    </option>
                    {map.floors.map((item) => (
                      <option key={item.id} value={item.id}>
                        {t(`location.floor.${item.id}`, {
                          defaultValue: item.name,
                        })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset disabled={busy} className="location-tier-field">
                <legend>{t('location.questionTier')}</legend>
                {(['easy', 'medium', 'hard'] as const).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="location-tier"
                      checked={tier === value}
                      onChange={() => setTier(value)}
                    />
                    {t(`location.${value}`)}
                  </label>
                ))}
              </fieldset>
              <label>
                {t('location.capturePoint')}
                <input
                  className="input"
                  required
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  maxLength={64}
                  value={point}
                  disabled={busy || Boolean(captureDraft) || lockedPoint}
                  onChange={(event) => setPoint(event.target.value)}
                />
                <small>{t('location.capturePointHelp')}</small>
              </label>
              <div className="location-form-grid">
                <label>
                  {t('location.captureTime')}
                  <input
                    className="input"
                    type="datetime-local"
                    value={capturedAt}
                    disabled={busy}
                    onChange={(event) => setCapturedAt(event.target.value)}
                  />
                </label>
                <label>
                  {t('location.gameBuild')}
                  <input
                    className="input"
                    maxLength={100}
                    placeholder="Steam build ID"
                    value={build}
                    disabled={busy}
                    onChange={(event) => setBuild(event.target.value)}
                  />
                </label>
              </div>
              <label>
                {t('location.captureSource')}
                <input
                  className="input"
                  maxLength={500}
                  value={source}
                  disabled={busy}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <details className="location-position-paste">
                <summary>{t('location.optionalPositionTools')}</summary>
                <p className="muted">{t('location.optionalPositionHelp')}</p>
                <PositionCodeInput
                  value={paste}
                  disabled={busy}
                  requireAngles
                  help={lockedPoint ? t('location.sharedPositionCodeHelp') : undefined}
                  onParsed={applyPosition}
                  onChange={(code) => {
                    setPaste(code);
                    if (!sharedWorld) {
                      setWorld({ x: '', y: '', z: '' });
                      setPin(null);
                    }
                    setPointMismatch(false);
                    setView((previous) => ({
                      ...previous,
                      pitch: '',
                      yaw: '',
                      roll: '',
                    }));
                    setError('');
                  }}
                />
                <h3>04 · {t('location.measuredPosition')}</h3>
                {lockedPoint && <p className="location-rules-note">{t('location.sharedPositionHelp')}</p>}
                <div className="location-form-grid three">
                  {(['x', 'y', 'z'] as const).map((key) => (
                    <div key={key}>
                      {numberField(
                        t(`location.world${key.toUpperCase()}`),
                        world[key],
                        (value) => {
                          setPaste('');
                          setWorld((previous) => ({ ...previous, [key]: value }));
                        },
                        lockedPoint
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || !floorId || !withinRadar}
                  onClick={() => converted && setPin(converted)}
                >
                  <ImagePlus size={15} />
                  {t('location.locateWorld')}
                </button>
                {converted && !withinRadar && (
                  <p className="location-error">
                    {t('location.coordinateOutside')}
                  </p>
                )}
                {mismatch && (
                  <p className="location-error">
                    {t('location.errors.LOCATION_COORDINATE_MISMATCH')}
                  </p>
                )}
                <h3>05 · {t('location.camera')}</h3>
                <div className="location-form-grid">
                  {(['pitch', 'yaw', 'roll', 'fov'] as const).map((key) => (
                    <div key={key}>
                      {numberField(t(`location.${key}`), view[key], (value) => {
                        if (key !== 'fov') { setPaste(''); setPointMismatch(false); }
                        setView((previous) => ({ ...previous, [key]: value }));
                      })}
                    </div>
                  ))}
                </div>
              </details>
              {!canPublish && (
                <p className="location-rules-note">
                  {t(mismatch ? 'location.errors.LOCATION_COORDINATE_MISMATCH' : 'location.publishRequirements')}
                </p>
              )}
            </section>
          </div>
        </div>
        <footer className="location-upload-footer">
          <span>{t(saving ? 'location.saving' : 'location.draftNotice')}</span>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn"
              data-status="draft"
              disabled={busy || !asset}
            >
              {t('location.saveDraft')}
            </button>
            {captureDraft && (
              <button
                type="submit"
                className="btn"
                data-status="draft"
                data-next="true"
                disabled={busy || !asset}
              >
                {t('location.captureSaveNext')}
              </button>
            )}
            {question && (
              <button
                type="submit"
                className="btn btn-ghost"
                data-status="disabled"
                disabled={busy}
              >
                {t('location.disable')}
              </button>
            )}
            <button
              type="submit"
              className="btn btn-ghost"
              data-status="review"
              disabled={busy || !asset}
            >
              {t('location.reviewStatus')}
            </button>
            <button
              type="submit"
              className="btn location-start"
              data-status="published"
              disabled={busy || !asset || !canPublish}
            >
              {t('location.publish')}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
