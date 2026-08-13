// ── Mine contacts tab: shared list, search, tap-to-call ────────────

import { $, $$, esc, on, toast, confirmDlg, modalForm, debounce, formatPhone } from './util.js';
import { S, findRow, save, softDelete, activeContacts, activeUsers, newContact } from './store.js';

let q = '';

export function initContacts() {
  on('data:contacts', renderContacts);
  on('data:users', renderContacts); // crew auto-appears here as they sign in
  on('owner', renderContacts);
  $('#contact-search').oninput = debounce(e => {
    q = e.target.value.trim().toLowerCase();
    renderContacts();
  }, 120);
  $('#btn-add-contact').onclick = addContact;
}

const telHref = p => (p || '').replace(/[^+\d]/g, '');
const phoneIcon = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3A19.5 19.5 0 0 1 5.1 13 19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7A2 2 0 0 1 22 16.9z"/></svg>`;
const msgIcon = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

function contactCard({ id, kind, company, sub, name, phone }) {
  const tel = telHref(phone);
  return `
    <div class="contact-card" data-id="${id}" data-kind="${kind}">
      <div class="contact-info">
        <div class="contact-company">${esc(company)}</div>
        <div class="contact-name">${esc(name)}</div>
        <div class="contact-phone">${esc(sub ? sub + ' · ' : '')}${esc(phone)}</div>
      </div>
      <div class="contact-actions">
        <a class="msg-btn" href="sms:${esc(tel)}" title="Text">${msgIcon}</a>
        <a class="call-btn" href="tel:${esc(tel)}" title="Call">${phoneIcon}</a>
      </div>
    </div>`;
}

export function renderContacts() {
  const root = $('#contacts-list');
  const crew = activeUsers().map(u => ({
    id: u.id, kind: 'crew', company: u.company || 'Crew', sub: u.position || '',
    name: u.name, phone: formatPhone(u.phone),
  }));
  const contacts = activeContacts().map(c => ({
    id: c.id, kind: 'contact', company: c.company, sub: c.position || '', name: c.name, phone: c.phone,
  }));
  const all = [...crew, ...contacts].filter(x =>
    !q || `${x.company} ${x.sub} ${x.name} ${x.phone}`.toLowerCase().includes(q));

  if (!all.length) {
    root.innerHTML = `<div class="empty-hint">${q
      ? 'No one matches your search.'
      : 'No contacts yet. Everyone who signs in shows up here — add mine office, safety, or dispatch with + Add.'}</div>`;
    return;
  }

  root.innerHTML = all.map(contactCard).join('');
  $$('.contact-card', root).forEach(card => {
    // only manually-added contacts are editable here; crew is managed in Settings
    if (card.dataset.kind === 'contact') {
      $('.contact-info', card).onclick = () => editContact(card.dataset.id);
    }
  });
}

async function addContact() {
  const res = await modalForm({
    title: 'Add contact',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'e.g. Mine Office', required: true },
      { name: 'name', label: 'Name', placeholder: 'e.g. John Smith', required: true },
      { name: 'position', label: 'Title / position (optional)', placeholder: 'e.g. Safety Director' },
      { name: 'phone', label: 'Phone', type: 'tel', placeholder: '(555) 555-5555', required: true },
    ],
    okText: 'Add',
  });
  if (!res) return;
  await newContact(res.company.trim(), res.name.trim(), res.phone.trim(), (res.position || '').trim());
  toast('Contact added for the whole crew', 'ok');
}

async function editContact(id) {
  const c = findRow('contacts', id);
  if (!c) return;
  const res = await modalForm({
    title: 'Edit contact',
    fields: [
      { name: 'company', label: 'Company', value: c.company, required: true },
      { name: 'name', label: 'Name', value: c.name, required: true },
      { name: 'position', label: 'Title / position (optional)', value: c.position || '' },
      { name: 'phone', label: 'Phone', type: 'tel', value: c.phone, required: true },
    ],
    deleteText: S.owner ? 'Delete contact' : null,
  });
  if (!res) return;
  if (res._delete) {
    if (await confirmDlg(`Delete ${c.name} for everyone?`, { okText: 'Delete', danger: true })) {
      await softDelete('contacts', c);
      toast('Contact deleted', 'ok');
    }
    return;
  }
  await save('contacts', {
    ...c, company: res.company.trim(), name: res.name.trim(),
    position: (res.position || '').trim(), phone: res.phone.trim(),
  });
}
