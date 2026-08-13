// ── Mine contacts tab: shared list, search, tap-to-call ────────────

import { $, $$, esc, on, toast, confirmDlg, modalForm, debounce } from './util.js';
import { S, findRow, save, softDelete, activeContacts, newContact } from './store.js';

let q = '';

export function initContacts() {
  on('data:contacts', renderContacts);
  on('owner', renderContacts);
  $('#contact-search').oninput = debounce(e => {
    q = e.target.value.trim().toLowerCase();
    renderContacts();
  }, 120);
  $('#btn-add-contact').onclick = addContact;
}

export function renderContacts() {
  const root = $('#contacts-list');
  const list = activeContacts().filter(c =>
    !q || `${c.company} ${c.name} ${c.phone}`.toLowerCase().includes(q));

  if (!list.length) {
    root.innerHTML = `<div class="empty-hint">${q
      ? 'No contacts match your search.'
      : 'No contacts yet. Add mine office, safety, dispatch — everyone on the job sees this list.'}</div>`;
    return;
  }

  root.innerHTML = list.map(c => `
    <div class="contact-card" data-id="${c.id}">
      <div class="contact-info">
        <div class="contact-company">${esc(c.company)}</div>
        <div class="contact-name">${esc(c.name)}</div>
        <div class="contact-phone">${esc(c.phone)}</div>
      </div>
      <div class="contact-actions">
        <a class="call-btn" href="tel:${esc((c.phone || '').replace(/[^+\d]/g, ''))}" title="Call">
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3A19.5 19.5 0 0 1 5.1 13 19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7A2 2 0 0 1 22 16.9z"/></svg>
        </a>
      </div>
    </div>`).join('');

  $$('.contact-card', root).forEach(card => {
    $('.contact-info', card).onclick = () => editContact(card.dataset.id);
  });
}

async function addContact() {
  const res = await modalForm({
    title: 'Add contact',
    fields: [
      { name: 'company', label: 'Company', placeholder: 'e.g. Mine Office', required: true },
      { name: 'name', label: 'Name', placeholder: 'e.g. John Smith', required: true },
      { name: 'phone', label: 'Phone', type: 'tel', placeholder: '(555) 555-5555', required: true },
    ],
    okText: 'Add',
  });
  if (!res) return;
  await newContact(res.company.trim(), res.name.trim(), res.phone.trim());
  toast('Contact added for the whole crew', 'ok');
}

async function editContact(id) {
  const c = findRow('contacts', id);
  if (!c) return;
  const fields = [
    { name: 'company', label: 'Company', value: c.company, required: true },
    { name: 'name', label: 'Name', value: c.name, required: true },
    { name: 'phone', label: 'Phone', type: 'tel', value: c.phone, required: true },
  ];
  if (S.owner) fields.push({ name: 'del', label: 'Type DELETE to remove this contact', placeholder: '' });
  const res = await modalForm({ title: 'Edit contact', fields });
  if (!res) return;
  if (S.owner && res.del === 'DELETE') {
    if (await confirmDlg(`Delete ${c.name}?`, { okText: 'Delete', danger: true })) {
      await softDelete('contacts', c);
      toast('Contact deleted', 'ok');
    }
    return;
  }
  await save('contacts', { ...c, company: res.company.trim(), name: res.name.trim(), phone: res.phone.trim() });
}
