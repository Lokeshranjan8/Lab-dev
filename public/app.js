const $ = (selector, root = document) => root.querySelector(selector);
const appRoot = $('#app');
const viewRoot = $('#view');
const params = new URLSearchParams(location.search);
const editToken = params.get('edit');
let toastTimer;
const esc = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const scholarHref = (name, professor = false) => professor && name.trim().toLowerCase() === 'dr. sushant kumar shrivastava'
  ? 'https://scholar.google.com/scholar?hl=en&as_sauthors=Sushant+Kumar+Shrivastava'
  : `https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(name)}`;
const api = async (url, options = {}) => {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
};
function notify(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
function tokenHeaders(token = editToken) { return token ? { 'x-edit-token': token } : {}; }
function compoundRow(item, owner = false, taId = '') {
  const recordId = item.synthesis_id;
  return `<div class="compound-row">
    <a href="/compound/${encodeURIComponent(item.compound_id)}" class="structure-thumb">${item.image_path ? `<img src="${esc(item.image_path)}" alt="Structure of ${esc(item.name)}">` : '<span class="placeholder">⌬</span>'}</a>
    <a href="/compound/${encodeURIComponent(item.compound_id)}" class="compound-info"><h3>${esc(item.name)}</h3><p>${esc((item.creators || []).map((creator) => creator.name).join(', '))} · ${esc(item.professor_name || '')}</p></a>
    <span class="formula">${esc(item.molecular_formula || 'Formula pending')}${owner && item.status !== 'approved' ? `<br><span class="status">${esc(item.status)}</span>` : ''}</span>
    ${owner ? `<div class="record-actions"><button class="button small secondary" data-edit-record="${esc(recordId)}" data-compound="${esc(item.compound_id)}" data-ta="${esc(taId)}" data-professor="${esc(item.professor_id)}" data-name="${esc(item.name)}" data-formula="${esc(item.molecular_formula || '')}" data-weight="${esc(item.molecular_weight || '')}" data-procedure="${esc(item.procedure || '')}" data-yield="${esc(item.yield || '')}" data-date="${esc(item.date_made || '')}">Edit</button><button class="button small danger" data-delete-record="${esc(recordId)}" data-ta="${esc(taId)}">Delete</button></div>` : ''}
  </div>`;
}
function taCompoundCard(item, owner = false, index = 0) {
  const nameParts = String(item.compound_name || '').split(' · ');
  const collectionName = nameParts[0] || 'Compound';
  const compoundCode = nameParts[1] || '';
  const displayName = nameParts.length > 2 ? nameParts.slice(2).join(' · ') : (compoundCode || item.compound_name);
  return `<article class="ta-compound-card">
    <div class="ta-compound-structure">${item.image_path ? `<a href="${esc(item.image_path)}" target="_blank" rel="noopener" aria-label="Open structure image for ${esc(item.compound_name)}"><img class="ta-compound-image" src="${esc(item.image_path)}" alt="Structure of ${esc(item.compound_name)}"></a><small class="structure-caption">Structure preview from ChemDraw data</small>` : '<div class="ta-compound-no-image"><span aria-hidden="true">⌬</span><p>Structure image not included</p><small>Download the ChemDraw file to view the editable structure.</small></div>'}</div>
    <div class="ta-compound-details"><span class="compound-index">COMPOUND ${String(index + 1).padStart(2, '0')}</span>${compoundCode ? `<p class="compound-series">${esc(collectionName)} · ${esc(compoundCode)}</p>` : ''}<h3>${esc(displayName)}</h3><p>${esc(item.molecular_formula || 'Formula not provided')}</p>${item.cdx_file_name ? `<p class="compound-filename">ChemDraw file: <span>${esc(item.cdx_file_name)}</span></p>` : ''}${item.notes ? `<p>${esc(item.notes)}</p>` : ''}</div>
    <div class="ta-compound-actions"><a class="button small" href="${esc(item.cdx_file_path)}" download="${esc(item.cdx_file_name || `${item.compound_name}.cdx`)}">Download original ChemDraw</a>${owner ? `<button class="button small secondary" data-edit-ta-compound="${esc(item.id)}">Edit</button><button class="button small danger" data-delete-ta-compound="${esc(item.id)}">Delete</button>` : ''}</div>
  </article>`;
}
function navigate(url) {
  history.pushState({}, '', url);
  renderRoute();
}
async function renderHome() {
  appRoot.hidden = false; viewRoot.hidden = true;
  const data = await api('/api/home');
  $('#professor-count').textContent = `${data.professors.length} FACULTY LAB${data.professors.length === 1 ? '' : 'S'}`;
  const researcherCount = data.professors.reduce((total, professor) => total + professor.ta_count, 0);
  const compoundCount = data.professors.reduce((total, professor) => total + professor.compound_count, 0);
  $('#directory-stats').innerHTML = `<span><strong>${researcherCount}</strong> researchers</span><span><strong>${compoundCount}</strong> compounds</span>`;
  $('#professors').innerHTML = data.professors.map((professor, index) => `<a href="/professor/${encodeURIComponent(professor.id)}" class="professor-card"><span class="professor-card-top"><span class="index">LAB ${String(index + 1).padStart(2, '0')}</span><span class="card-arrow" aria-hidden="true">↗</span></span><h3>${esc(professor.name)}</h3><p>${esc(professor.department || professor.lab_name || 'Faculty laboratory')}</p><span class="professor-card-meta"><span>${professor.ta_count} researcher${professor.ta_count === 1 ? '' : 's'}</span><span>${professor.compound_count} compound${professor.compound_count === 1 ? '' : 's'}</span></span></a>`).join('') || '<p class="empty-state">No faculty labs have been added.</p>';
}
async function renderSearch(query) {
  const target = $('#search-results');
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const requestId = ++searchRequestId;
  if (!normalizedQuery) { target.hidden = true; target.innerHTML = ''; return; }
  target.innerHTML = '<p class="search-state" role="status">Searching researchers and compounds…</p>';
  target.hidden = false;
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(normalizedQuery)}`);
    if (requestId !== searchRequestId || $('#search').value.trim().replace(/\s+/g, ' ') !== normalizedQuery) return;
    const people = Array.isArray(result.people) ? result.people : [];
    const compounds = Array.isArray(result.taCompounds) ? result.taCompounds : [];
    const peopleHtml = people.map((person) => `<a href="/${person.kind === 'ta' ? 'ta' : 'professor'}/${encodeURIComponent(person.id)}"><span class="search-kind">${person.kind === 'ta' ? 'Researcher' : 'Faculty lab'}</span>${esc(person.name)}<span class="search-detail">${esc(person.professor_name)}${person.batch_year ? ` · batch ${esc(person.batch_year)}` : ''} · ${Number(person.compound_count) || 0} compounds</span></a>`).join('');
    const compoundsHtml = compounds.map((item) => `<a href="/ta/${encodeURIComponent(item.ta_id)}"><span class="search-kind">${esc(item.researcher_name)} · ${esc(item.professor_name || 'Researcher')}</span>${esc(item.compound_name)}<span class="search-detail">Personal compound · open profile for structure preview and ChemDraw download</span></a>`).join('');
    const html = `${peopleHtml ? `<div class="search-kind search-group-heading">PEOPLE</div>${peopleHtml}` : ''}${compoundsHtml ? `<div class="search-kind search-group-heading">COMPOUNDS</div>${compoundsHtml}` : ''}`;
    target.innerHTML = html || `<p class="search-state">No matches for “${esc(normalizedQuery)}”. Try a researcher name, compound name, or filename/code.</p>`;
  } catch (error) {
    if (requestId !== searchRequestId) return;
    target.innerHTML = `<p class="search-state search-error">Search is unavailable right now. ${esc(error.message)}</p>`;
  }
}
async function renderProfessor(id) {
  const data = await api(`/api/professors/${encodeURIComponent(id)}`);
  const owned = params.get('professor') === id ? params.get('edit') : null;
  viewRoot.hidden = false; appRoot.hidden = true;
  const compoundCount = data.tas.reduce((total, ta) => total + ta.compound_count, 0);
  const isSushant = data.professor.name.trim().toLowerCase() === 'dr. sushant kumar shrivastava';
  const scholarlyLinks = isSushant
    ? `<div class="scholarly-links"><a class="scholar-profile-link" href="${scholarHref(data.professor.name, true)}" target="_blank" rel="noopener noreferrer">Google Scholar publications ↗</a><a class="scholar-profile-link" href="https://www.iitbhu.ac.in/dept/phe/people/skshrivastavaphe" target="_blank" rel="noopener noreferrer">IIT (BHU) publications ↗</a></div>`
    : `<a class="scholar-profile-link" href="${scholarHref(data.professor.name, true)}" target="_blank" rel="noopener noreferrer">Find profile on Google Scholar ↗</a>`;
  viewRoot.innerHTML = `<a class="back-link" href="/">← Research directory</a><section class="profile-heading faculty-heading"><p class="eyebrow">FACULTY LAB</p><h1>${esc(data.professor.name)}</h1><p>${esc(data.professor.department)}${data.professor.lab_name ? ` · ${esc(data.professor.lab_name)}` : ''}</p>${scholarlyLinks}<div class="profile-metrics"><div><strong>${data.tas.length}</strong><span>Researchers</span></div><div><strong>${compoundCount}</strong><span>Personal compounds</span></div><div><strong>${esc(data.professor.research_area || 'Research')}</strong><span>Focus area</span></div></div>${owned ? '<div class="owner-bar"><button class="button" id="add-ta">Add researcher</button></div>' : ''}</section><section class="content-section faculty-roster"><div class="section-head"><div><p class="eyebrow">THE GROUP</p><h2>Researchers</h2><p class="section-description">Browse each profile to view structure previews and download the original ChemDraw files.</p></div><span class="section-count">${data.tas.length} PROFILES</span></div><div class="roster-grid">${data.tas.map((ta, index) => `<article class="researcher-card"><a class="researcher-card-link" href="/ta/${encodeURIComponent(ta.id)}"><span class="researcher-avatar" aria-hidden="true">${esc(ta.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase())}</span><span class="researcher-card-index">RESEARCHER ${String(index + 1).padStart(2, '0')}</span><h3>${esc(ta.name)}</h3><p>${ta.is_alumni ? 'Alumni researcher' : 'Researcher'}${ta.batch_year ? ` · Batch ${esc(ta.batch_year)}` : ''}</p><span class="researcher-card-meta">${ta.compound_count} compound${ta.compound_count === 1 ? '' : 's'} <span aria-hidden="true">↗</span></span></a><a class="scholar-profile-link researcher-scholar-link" href="${scholarHref(ta.name)}" target="_blank" rel="noopener noreferrer">Find on Google Scholar ↗</a>${owned ? `<button class="button small secondary remove-researcher" data-remove-ta="${esc(ta.id)}" data-professor="${esc(id)}">Remove from lab</button>` : ''}</article>`).join('') || '<p class="empty-state">No researchers listed yet.</p>'}</div></section>`;
  if (owned) {
    $('#add-ta').addEventListener('click', () => showTaForm(id, owned));
    viewRoot.querySelectorAll('[data-remove-ta]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Remove this TA from the active roster? Their profile and past work remain.')) return;
      try { await api(`/api/professors/${id}/tas/${button.dataset.removeTa}`, { method: 'DELETE', headers: { 'x-edit-token': owned } }); notify('TA removed from the roster.'); renderProfessor(id); }
      catch (error) { notify(error.message); }
    }));
  }
}
async function renderTa(id) {
  const owned = editToken && params.get('ta') === id;
  const data = await api(`/api/tas/${encodeURIComponent(id)}`, { headers: owned ? tokenHeaders() : {} });
  viewRoot.hidden = false; appRoot.hidden = true;
  const professors = data.ta.professors || [];
  const taCompounds = data.taCompounds || [];
  const collections = [...new Set(taCompounds.map((item) => String(item.compound_name || '').split(' · ')[0]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  viewRoot.innerHTML = `<a class="back-link" href="/">← Research directory</a><section class="profile-heading researcher-heading"><p class="eyebrow">RESEARCHER PROFILE</p><h1>${esc(data.ta.name)}</h1><p class="affiliation-links">${professors.map((professor) => `<a href="/professor/${encodeURIComponent(professor.id)}">${esc(professor.name)}</a>`).join(' · ')}</p><a class="scholar-profile-link" href="${scholarHref(data.ta.name)}" target="_blank" rel="noopener noreferrer">Find profile on Google Scholar ↗</a><p class="profile-subtitle">${data.ta.batch_year ? `Batch ${esc(data.ta.batch_year)}` : 'Researcher'}${data.ta.is_alumni ? ' · Alumni' : ''}</p>${data.ta.bio ? `<p class="intro">${esc(data.ta.bio)}</p>` : ''}<div class="profile-metrics"><div><strong>${taCompounds.length}</strong><span>Compounds</span></div><div><strong>${collections.length}</strong><span>Collections</span></div><div><strong>${professors.length}</strong><span>Faculty affiliation${professors.length === 1 ? '' : 's'}</span></div></div>${owned ? '<div class="owner-bar"><button class="button" id="add-ta-compound">Add compound</button><button class="button secondary" id="edit-profile">Edit profile</button></div>' : ''}</section>`;
  viewRoot.insertAdjacentHTML('beforeend', `<section class="content-section ta-compounds-section"><div class="section-head"><div><p class="eyebrow">RESEARCH COLLECTION</p><h2>Compound structures</h2><p class="section-description">Browse the structure previews and download the original ChemDraw files.</p></div></div>${taCompounds.length ? `<div class="collection-download-bar"><a class="button collection-download" href="/api/tas/${encodeURIComponent(id)}/compounds.zip" download>Download all ${taCompounds.length} compounds (.zip)</a><span>Original ChemDraw files, structure previews, and a manifest for this researcher</span></div>` : ''}<div class="compound-toolbar"><label class="compound-filter-label" for="compound-filter">Search this collection</label><input id="compound-filter" type="search" placeholder="Search compound name or code"><label class="compound-filter-label" for="collection-filter">Collection</label><select id="collection-filter"><option value="">All collections (${taCompounds.length})</option>${collections.map((collection) => `<option value="${esc(collection)}">${esc(collection)} (${taCompounds.filter((item) => String(item.compound_name || '').startsWith(`${collection} · `)).length})</option>`).join('')}</select><span id="compound-result-count" class="section-count"></span></div><div class="ta-compound-grid">${taCompounds.map((item, index) => taCompoundCard(item, owned, index)).join('') || '<p class="empty-state">No compounds have been added to this profile yet.</p>'}</div></section>`);
  const filterCompounds = () => {
    const query = $('#compound-filter').value.trim().toLowerCase();
    const collection = $('#collection-filter').value;
    let visible = 0;
    viewRoot.querySelectorAll('.ta-compound-card').forEach((card, index) => {
      const item = taCompounds[index];
      const matches = (!query || `${item.compound_name} ${item.cdx_file_name || ''}`.toLowerCase().includes(query)) && (!collection || String(item.compound_name || '').startsWith(`${collection} · `));
      card.hidden = !matches;
      if (matches) visible += 1;
    });
    $('#compound-result-count').textContent = `${visible} OF ${taCompounds.length} COMPOUNDS`;
  };
  $('#compound-filter').addEventListener('input', filterCompounds);
  $('#collection-filter').addEventListener('change', filterCompounds);
  filterCompounds();
  if (owned) {
    $('#add-ta-compound').addEventListener('click', () => showTaCompoundForm(id));
    viewRoot.querySelectorAll('[data-edit-ta-compound]').forEach((button) => {
      const item = data.taCompounds.find((compound) => compound.id === button.dataset.editTaCompound);
      button.addEventListener('click', () => showTaCompoundForm(id, item));
    });
    viewRoot.querySelectorAll('[data-delete-ta-compound]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('Delete this compound and its uploaded files?')) return;
      try {
        await api(`/api/tas/${id}/ta-compounds/${encodeURIComponent(button.dataset.deleteTaCompound)}`, { method: 'DELETE', headers: tokenHeaders() });
        notify('Compound deleted.');
        renderTa(id);
      } catch (error) { notify(error.message); }
    }));
    $('#edit-profile').addEventListener('click', async () => { const home = await api('/api/home'); showProfileForm(id, data.ta, home.professors); });
  }
}
async function renderCompound(id) {
  const data = await api(`/api/compounds/${encodeURIComponent(id)}`);
  const item = data.records[0];
  viewRoot.hidden = false; appRoot.hidden = true;
  viewRoot.innerHTML = `<a class="back-link" href="/">← Lab works</a><section class="profile-heading"><p class="eyebrow">COMPOUND RECORD</p><h1>${esc(item.name)}</h1><p>${esc(item.molecular_formula)} · ${item.molecular_weight ? `${esc(item.molecular_weight)} g/mol` : 'Molecular weight not recorded'} · ${esc(item.compound_type)}</p></section>${data.records.map((record) => `<section class="profile-columns"><div class="preview-box">${record.image_path ? `<img src="${esc(record.image_path)}" alt="Structure of ${esc(record.name)}">` : '<span class="placeholder">⌬</span>'}</div><div class="records"><p class="eyebrow">SYNTHESIS RECORD</p><p><strong>Made by</strong> ${(record.creators || []).map((creator) => `<a href="/ta/${encodeURIComponent(creator.id)}">${esc(creator.name)}</a>`).join(', ')}</p><p><strong>Supervised by</strong> <a href="/professor/${encodeURIComponent(record.professor_id)}">${esc(record.professor_name)}</a></p><p><strong>Date</strong> ${esc(record.date_made || 'Not recorded')}</p><p><strong>Yield</strong> ${esc(record.yield || 'Not recorded')}</p><p>${esc(record.procedure || '')}</p>${record.chemdraw_file_path ? `<a class="button" href="${esc(record.chemdraw_file_path)}" download>Download original ChemDraw file</a>` : ''}</div></section>`).join('')}`;
}
async function renderRoute() {
  const segments = location.pathname.split('/').filter(Boolean);
  try {
    if (!segments.length) return renderHome();
    if (segments[0] === 'professor' && segments[1]) return renderProfessor(segments[1]);
    if (segments[0] === 'ta' && segments[1]) return renderTa(segments[1]);
    if (segments[0] === 'compound' && segments[1]) return renderCompound(segments[1]);
    return renderHome();
  } catch (error) { viewRoot.hidden = false; appRoot.hidden = true; viewRoot.innerHTML = `<a class="back-link" href="/">← Lab works</a><p class="empty-state">${esc(error.message)}</p>`; }
}
function showCompoundForm(taId, record = null, professors = []) {
  const dialog = $('#form-dialog'); $('#form-title').textContent = record ? 'Edit synthesis record' : 'Add compound';
  const editing = Boolean(record);
  const professorOptions = professors.map((professor) => `<option value="${esc(professor.id)}" ${record?.professor === professor.id ? 'selected' : ''}>${esc(professor.name)}</option>`).join('');
  $('#form-content').innerHTML = `<form id="compound-form"><div class="form-grid"><div><label>Compound name<input name="name" required maxlength="200" value="${esc(record?.name || '')}"></label></div><div><label>Supervising professor<select name="professorId" required>${professorOptions}</select></label></div><div><label>Compound type<select name="compoundType"><option value="organic">Organic</option><option value="inorganic">Inorganic</option><option value="organometallic">Organometallic</option><option value="polymer">Polymer</option><option value="other" selected>Other</option></select></label></div><div><label>SMILES (optional)<input name="smiles" placeholder="Paste a SMILES string"></label></div><div><label>Molecular formula<input name="formula" value="${esc(record?.formula || '')}" placeholder="Calculated from CDXML when possible"></label></div><div><label>Molecular weight<input name="molecularWeight" type="number" step="0.0001" value="${esc(record?.weight || '')}"></label></div><div><label>Date made<input name="dateMade" type="date" value="${esc(record?.date || '')}"></label></div><div><label>Yield<input name="yield" maxlength="100" value="${esc(record?.yield || '')}" placeholder="e.g. 72%"></label></div><div class="full"><label>Procedure<textarea name="procedure">${esc(record?.procedure || '')}</textarea></label></div><div class="full"><label>ChemDraw file (.cdxml or .cdx)<input type="file" name="chemdraw" accept=".cdxml,.cdx"><span class="form-note">.cdxml gives a generated preview and estimated formula. .cdx needs a matching image export. .chm is unsupported.</span></label></div><div class="full"><label>Structure image (PNG, JPG, WEBP, SVG)<input type="file" name="image" accept=".png,.jpg,.jpeg,.webp,.svg"></label></div></div><div id="preview-box" class="preview-box"><span class="form-note">Structure preview appears here before saving.</span></div><p class="form-note">New and edited records are submitted as pending for professor approval. CDXML formula and weight use approximate standard-valence hydrogen assignment.</p><button class="button" type="submit">${editing ? 'Save changes' : 'Submit for approval'}</button></form>`;
  dialog.showModal();
  const form = $('#compound-form');
  form.elements.compoundType.value = record?.compoundType || 'other';
  let preview;
  form.addEventListener('change', async (event) => {
    if (!['chemdraw','image'].includes(event.target.name)) return;
    const formData = new FormData(form);
    try {
      preview = await api('/api/preview', { method: 'POST', body: formData });
      if (preview.formula) form.elements.formula.value = preview.formula;
      if (preview.molecularWeight) form.elements.molecularWeight.value = preview.molecularWeight;
      $('#preview-box').innerHTML = preview.svg || (preview.imagePreview ? `<img src="${preview.imagePreview}" alt="Structure preview">` : '<span class="form-note">No preview available.</span>');
    } catch (error) { $('#preview-box').textContent = error.message; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = new FormData(form);
    try {
      const url = editing ? `/api/tas/${taId}/synthesis/${record.editRecord}` : `/api/tas/${taId}/compounds`;
      const options = editing ? { method: 'PATCH', headers: tokenHeaders(), body: JSON.stringify(Object.fromEntries(body)) } : { method: 'POST', headers: tokenHeaders(), body };
      const result = await api(url, options);
      dialog.close(); notify(editing ? 'Changes saved; approval reset to pending.' : 'Submitted for professor approval.'); renderTa(taId);
    } catch (error) { notify(error.message); }
  });
}
function showTaCompoundForm(taId, compound = null) {
  const dialog = $('#form-dialog');
  const editing = Boolean(compound);
  $('#form-title').textContent = editing ? 'Edit compound' : 'Add compound';
  $('#form-content').innerHTML = `<form id="ta-compound-form"><label>Compound name<input name="compoundName" required maxlength="200" value="${esc(compound?.compound_name || '')}"></label><label>Molecular formula (optional)<input name="molecularFormula" maxlength="80" value="${esc(compound?.molecular_formula || '')}"></label><label>Notes (optional)<textarea name="notes">${esc(compound?.notes || '')}</textarea></label><div class="form-grid"><label>Structure image (PNG, JPG, SVG)<input name="structureImage" type="file" accept=".png,.jpg,.jpeg,.svg" ${editing ? '' : 'required'}><span class="form-note">Maximum 5 MB</span></label><label>ChemDraw file (.cdx or .cdxml)<input name="chemdraw" type="file" accept=".cdx,.cdxml" ${editing ? '' : 'required'}><span class="form-note">Maximum 10 MB</span></label></div><div id="ta-compound-preview" class="preview-box">${compound ? `<img src="${esc(compound.image_path)}" alt="Current structure preview">` : '<span class="form-note">Choose a structure image to preview it.</span>'}</div><p class="form-note">When editing, leave a file field empty to keep its current file.</p><button class="button" type="submit">${editing ? 'Save changes' : 'Add compound'}</button></form>`;
  dialog.showModal();
  const form = $('#ta-compound-form');
  const imageInput = form.elements.structureImage;
  let previewUrl = null;
  imageInput.addEventListener('change', () => {
    const image = imageInput.files[0];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = image ? URL.createObjectURL(image) : null;
    $('#ta-compound-preview').innerHTML = previewUrl ? `<img src="${previewUrl}" alt="Structure image preview">` : '<span class="form-note">Choose a structure image to preview it.</span>';
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const image = imageInput.files[0];
    const drawing = form.elements.chemdraw.files[0];
    const imageExtension = image?.name.split('.').pop().toLowerCase();
    const drawingExtension = drawing?.name.split('.').pop().toLowerCase();
    if (!editing && (!image || !drawing)) return notify('Choose both a structure image and a ChemDraw file.');
    if (image && !['png','jpg','jpeg','svg'].includes(imageExtension)) return notify('Structure image must be PNG, JPG, or SVG.');
    if (drawing && !['cdx','cdxml'].includes(drawingExtension)) return notify('ChemDraw file must be CDX or CDXML.');
    if (image && image.size > 5 * 1024 * 1024) return notify('Structure image must be 5 MB or smaller.');
    if (drawing && drawing.size > 10 * 1024 * 1024) return notify('ChemDraw file must be 10 MB or smaller.');
    try {
      const body = new FormData(form);
      const route = `/api/tas/${taId}/ta-compounds${editing ? `/${encodeURIComponent(compound.id)}` : ''}`;
      await api(route, { method: editing ? 'PATCH' : 'POST', headers: tokenHeaders(), body });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      dialog.close();
      notify(editing ? 'Compound updated.' : 'Compound added.');
      renderTa(taId);
    } catch (error) { notify(error.message); }
  });
  dialog.addEventListener('close', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, { once: true });
}
function showProfileForm(id, profile, allProfessors = profile.professors || []) {
  const dialog = $('#form-dialog'); $('#form-title').textContent = 'Edit profile';
  const linkedIds = new Set((profile.professors || []).map((professor) => professor.id));
  const affiliations = allProfessors.map((professor) => `<label class="check-row"><input name="professorIds" type="checkbox" value="${esc(professor.id)}" ${linkedIds.has(professor.id) ? 'checked' : ''}> ${esc(professor.name)}</label>`).join('');
  $('#form-content').innerHTML = `<form id="profile-form"><label>Name<input name="name" required value="${esc(profile.name)}"></label><label>Professors</label><div class="check-list">${affiliations}</div><label>Roll number (private)<input name="rollNumber" value="${esc(profile.roll_number || '')}"></label><label>Email (optional)<input name="email" type="email" value="${esc(profile.email || '')}"></label><label>Batch year<input name="batchYear" type="number" value="${esc(profile.batch_year || '')}"></label><label>Student work / bio<textarea name="bio">${esc(profile.bio || '')}</textarea></label><label class="check-row"><input name="isAlumni" type="checkbox" ${profile.is_alumni ? 'checked' : ''}> Alumni</label><button class="button">Save student profile</button></form>`;
  dialog.showModal();
  $('#profile-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const body = Object.fromEntries(form); body.professorIds = form.getAll('professorIds'); body.isAlumni = form.has('isAlumni'); try { await api(`/api/tas/${id}`, { method: 'PATCH', headers: { ...tokenHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); dialog.close(); notify('Profile updated.'); renderTa(id); } catch (error) { notify(error.message); } });
}
async function showTaForm(professorId, token) {
  const { professors } = await api('/api/home');
  const dialog = $('#form-dialog'); $('#form-title').textContent = 'Add TA';
  $('#form-content').innerHTML = `<form id="ta-form"><label>Name<input name="name" required></label><fieldset class="check-list"><legend>Other professors this student works with</legend>${professors.filter((professor) => professor.id !== professorId).map((professor) => `<label class="check-row"><input name="professorIds" type="checkbox" value="${esc(professor.id)}"> ${esc(professor.name)}</label>`).join('') || '<span class="form-note">No other professors have been added.</span>'}</fieldset><div class="form-grid"><label>Roll number (private)<input name="rollNumber"></label><label>Email (optional)<input name="email" type="email"></label></div><label>Batch year<input name="batchYear" type="number"></label><label>Student work / bio<textarea name="bio"></textarea></label><button class="button">Create TA profile</button></form>`;
  dialog.showModal();
  $('#ta-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const body = Object.fromEntries(form); body.professorIds = form.getAll('professorIds'); try { const data = await api(`/api/professors/${professorId}/tas`, { method: 'POST', headers: { 'x-edit-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); dialog.close(); showSecretLink(`/ta/${data.ta.id}?ta=${data.ta.id}&edit=${encodeURIComponent(data.editToken)}`); renderProfessor(professorId); } catch (error) { notify(error.message); } });
}
function showSecretLink(url) { const dialog = $('#form-dialog'); $('#form-title').textContent = 'Save this edit link'; $('#form-content').innerHTML = `<p>This secret link is shown only now. Save it securely; it cannot be recovered, only regenerated by the site owner.</p><label>Secret profile edit link<input readonly value="${esc(`${location.origin}${url}`)}"></label><button class="button" id="copy-link">Copy link</button>`; dialog.showModal(); $('#copy-link').addEventListener('click', async () => { await navigator.clipboard.writeText(`${location.origin}${url}`); notify('Edit link copied.'); }); }

async function loadAdmin() {
  const key = $('#admin-key').value;
  if (!key) return notify('Enter the master key.');
  try {
    const pending = await api('/api/admin/pending', { headers: { 'x-admin-key': key } });
    const home = await api('/api/home');
    const profiles = await api('/api/admin/profiles', { headers: { 'x-admin-key': key } });
    const content = $('#admin-content');
    content.innerHTML = `<div class="admin-create"><h3>Create professor</h3><form id="professor-create" class="form-grid"><label>Name<input name="name" required></label><label>Department<input name="department"></label><label>Lab name<input name="labName"></label><label>Research area<input name="researchArea"></label><div class="full"><button class="button">Create professor</button></div></form><h3>Create TA</h3><form id="ta-create" class="form-grid"><label>Name<input name="name" required></label><label>Professor<select name="professorId" required>${home.professors.map((professor) => `<option value="${esc(professor.id)}">${esc(professor.name)}</option>`).join('')}</select></label><label>Roll number (private)<input name="rollNumber"></label><label>Email<input name="email" type="email"></label><label>Batch year<input name="batchYear" type="number"></label><div class="full"><button class="button">Create TA</button></div></form><h3>Regenerate edit link</h3><form id="regen-form" class="form-grid"><label>Profile type<select name="kind"><option value="professor">Professor</option><option value="ta">TA</option></select></label><label>Profile ID<input name="id" required></label><div class="full"><button class="button secondary">Regenerate secret link</button></div></form><h3>Private roll-number lookup</h3><form id="roll-search" class="form-grid"><label>Exact roll number<input name="rollNumber" required></label><div><button class="button secondary">Search</button></div></form><div id="roll-results"></div></div><h3>Review queue · ${pending.records.length}</h3>${pending.records.map((record) => `<div class="admin-record"><h3>${esc(record.name)} <span class="status">${esc(record.status)}</span></h3><p>${esc(record.molecular_formula)} · ${esc(record.professor_name)} · ${(record.creators || []).map((creator) => esc(creator.name)).join(', ')}</p><div class="record-actions"><button class="button small" data-status="approved" data-record="${esc(record.synthesis_id)}">Approve</button><button class="button small secondary" data-status="rejected" data-record="${esc(record.synthesis_id)}">Reject</button></div></div>`).join('') || '<p class="empty-state">The queue is clear.</p>'}`;
    content.insertAdjacentHTML('afterbegin', `<section class="profile-management"><h3>Profiles</h3><div class="profile-manage-columns"><div><h4>Faculty</h4>${profiles.professors.map((professor) => `<div class="admin-profile-row"><span>${esc(professor.name)}</span><button class="button small danger" data-delete-kind="professor" data-delete-id="${esc(professor.id)}" data-delete-name="${esc(professor.name)}">Delete</button></div>`).join('') || '<p class="empty-state">No faculty profiles.</p>'}</div><div><h4>Lab members</h4>${profiles.tas.map((ta) => `<div class="admin-profile-row"><span>${esc(ta.name)}<small>${esc(ta.professor_name || '')}</small></span><button class="button small danger" data-delete-kind="ta" data-delete-id="${esc(ta.id)}" data-delete-name="${esc(ta.name)}">Delete</button></div>`).join('') || '<p class="empty-state">No lab member profiles.</p>'}</div></div></section>`);
    content.insertAdjacentHTML('afterbegin', `<section class="admin-ta-upload"><h3>Upload compound to TA profile</h3><form id="admin-ta-compound-form"><label>TA profile<select name="taId" required><option value="">Choose a TA</option>${profiles.tas.map((ta) => `<option value="${esc(ta.id)}">${esc(ta.name)}${ta.professor_name ? ` · ${esc(ta.professor_name)}` : ''}</option>`).join('')}</select></label><div class="form-grid"><label>Compound name<input name="compoundName" required maxlength="200"></label><label>Molecular formula (optional)<input name="molecularFormula" maxlength="80"></label><label class="full">Notes (optional)<textarea name="notes"></textarea></label><label>Structure image (PNG, JPG, SVG)<input name="structureImage" type="file" accept=".png,.jpg,.jpeg,.svg" required><span class="form-note">Maximum 5 MB</span></label><label>ChemDraw file (.cdx or .cdxml)<input name="chemdraw" type="file" accept=".cdx,.cdxml" required><span class="form-note">Maximum 10 MB</span></label></div><div id="admin-ta-compound-preview" class="preview-box"><span class="form-note">Select an image to preview.</span></div><button class="button" type="submit">Upload compound</button></form></section>`);
    const adminCompoundForm = $('#admin-ta-compound-form');
    let adminPreviewUrl = null;
    adminCompoundForm.elements.structureImage.addEventListener('change', () => {
      const image = adminCompoundForm.elements.structureImage.files[0];
      if (adminPreviewUrl) URL.revokeObjectURL(adminPreviewUrl);
      adminPreviewUrl = image ? URL.createObjectURL(image) : null;
      $('#admin-ta-compound-preview').innerHTML = adminPreviewUrl ? `<img src="${adminPreviewUrl}" alt="Structure image preview">` : '<span class="form-note">Select an image to preview.</span>';
    });
    adminCompoundForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const image = adminCompoundForm.elements.structureImage.files[0];
      const drawing = adminCompoundForm.elements.chemdraw.files[0];
      if (!image || !drawing) return notify('Choose both a structure image and a ChemDraw file.');
      if (image.size > 5 * 1024 * 1024) return notify('Structure image must be 5 MB or smaller.');
      if (drawing.size > 10 * 1024 * 1024) return notify('ChemDraw file must be 10 MB or smaller.');
      try {
        await api(`/api/admin/tas/${encodeURIComponent(adminCompoundForm.elements.taId.value)}/ta-compounds`, { method: 'POST', headers: { 'x-admin-key': key }, body: new FormData(adminCompoundForm) });
        if (adminPreviewUrl) URL.revokeObjectURL(adminPreviewUrl);
        notify('Compound uploaded to TA profile.');
        loadAdmin();
      } catch (error) { notify(error.message); }
    });
    content.querySelectorAll('[data-delete-kind]').forEach((button) => {
      button.textContent = 'Archive';
      if (button.dataset.deleteKind !== 'ta') return;
      const row = button.closest('.admin-profile-row');
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Link ${button.dataset.deleteName} to faculty`);
      const prompt = document.createElement('option');
      prompt.value = '';
      prompt.textContent = 'Link to faculty';
      select.append(prompt);
      profiles.professors.forEach((professor) => {
        const option = document.createElement('option');
        option.value = professor.id;
        option.textContent = professor.name;
        select.append(option);
      });
      const linkButton = document.createElement('button');
      linkButton.className = 'button small secondary';
      linkButton.textContent = 'Link';
      linkButton.addEventListener('click', async () => {
        if (!select.value) return notify('Choose a faculty profile first.');
        try {
          await api(`/api/admin/tas/${encodeURIComponent(button.dataset.deleteId)}/professors`, {
            method: 'POST',
            headers: { 'x-admin-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ professorId: select.value })
          });
          notify('TA linked to faculty.');
          loadAdmin();
        } catch (error) { notify(error.message); }
      });
      row.append(select, linkButton);
    });
    content.querySelectorAll('[data-delete-kind]').forEach((button) => button.addEventListener('click', async () => {
      const kind = button.dataset.deleteKind;
      const name = button.dataset.deleteName;
      if (!confirm(`Archive ${kind === 'ta' ? 'lab member' : 'faculty profile'} “${name}”? Historical lab records will be retained.`)) return;
      const collection = kind === 'ta' ? 'tas' : 'professors';
      try {
        await api(`/api/admin/${collection}/${encodeURIComponent(button.dataset.deleteId)}`, { method: 'DELETE', headers: { 'x-admin-key': key } });
        notify('Profile archived; historical lab records retained.');
        loadAdmin();
      } catch (error) { notify(error.message); }
    }));
    const professorSelect = $('#ta-create select[name="professorId"]');
    professorSelect.closest('label').firstChild.textContent = 'Faculty labs (optional)';
    professorSelect.required = false;
    professorSelect.multiple = true;
    professorSelect.size = Math.min(4, home.professors.length);
    professorSelect.selectedIndex = -1;
    content.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/admin/synthesis/${button.dataset.record}/status`, { method: 'PATCH', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: button.dataset.status }) }); notify(`Record ${button.dataset.status}.`); loadAdmin(); } catch (error) { notify(error.message); } }));
    $('#professor-create').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await api('/api/admin/professors', { method: 'POST', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); showSecretLink(`/professor/${result.professor.id}?professor=${result.professor.id}&edit=${encodeURIComponent(result.editToken)}`); loadAdmin(); } catch (error) { notify(error.message); } });
    $('#ta-create').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const body = Object.fromEntries(form); body.professorIds = form.getAll('professorIds'); try { const result = await api('/api/admin/tas', { method: 'POST', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); showSecretLink(`/ta/${result.ta.id}?ta=${result.ta.id}&edit=${encodeURIComponent(result.editToken)}`); loadAdmin(); } catch (error) { notify(error.message); } });
    $('#regen-form').addEventListener('submit', async (event) => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget)); try { const result = await api(`/api/admin/regenerate/${fields.kind}/${encodeURIComponent(fields.id)}`, { method: 'POST', headers: { 'x-admin-key': key } }); const url = fields.kind === 'ta' ? `/ta/${result.id}?ta=${result.id}&edit=${encodeURIComponent(result.editToken)}` : `/professor/${result.id}?professor=${result.id}&edit=${encodeURIComponent(result.editToken)}`; showSecretLink(url); } catch (error) { notify(error.message); } });
    $('#roll-search').addEventListener('submit', async (event) => { event.preventDefault(); const rollNumber = new FormData(event.currentTarget).get('rollNumber'); try { const result = await api(`/api/admin/roll/${encodeURIComponent(rollNumber)}`, { headers: { 'x-admin-key': key } }); $('#roll-results').innerHTML = result.tas.map((ta) => `<div class="admin-record"><strong>${esc(ta.name)}</strong><p>${esc(ta.professor_name)} · ${ta.batch_year || 'Batch not set'} · ${esc(ta.id)}</p></div>`).join('') || '<p class="empty-state">No exact match.</p>'; } catch (error) { notify(error.message); } });
  } catch (error) { notify(error.message); }
}

let searchTimer;
let searchRequestId = 0;
$('#search').addEventListener('input', (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderSearch(event.target.value), 180); });
$('#search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); renderSearch(event.currentTarget.value); } });
$('#search').addEventListener('focus', (event) => { if (event.currentTarget.value.trim()) renderSearch(event.currentTarget.value); });
$('#search').addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('#search-results').hidden = true; } });
$('#admin-load').addEventListener('click', loadAdmin);
$('.admin-open').addEventListener('click', () => $('#admin-dialog').showModal());
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="/"]');
  if (link && !event.metaKey && !event.ctrlKey && !link.hasAttribute('download')) { event.preventDefault(); const url = new URL(link.href); navigate(`${url.pathname}${url.search}`); }
  if (!event.target.closest('.search-wrap')) $('#search-results').hidden = true;
});
window.addEventListener('popstate', renderRoute);
renderRoute().catch((error) => notify(error.message));
