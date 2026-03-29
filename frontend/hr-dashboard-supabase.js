(function () {
  const SUPABASE_URL = window.APP_CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.APP_CONFIG.SUPABASE_ANON_KEY;
  const TENANT_ID = window.APP_CONFIG.TENANT_ID;
  const STORAGE_BUCKET = "candidate-files";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let allCandidates = [];
  let candidateClientMap = {};
  let candidateClientIdMap = {};
  let clientsById = {};
  let currentId = null;
  let targetStatus = null;
  let currentTemplateId = null;
  let appConfig = {};
  let statusUpdateInFlight = false;
  let currentPage = 0;
  let totalCount = 0;
  let filteredSummary = {
    total: 0,
    interviewed: 0,
    selected: 0,
    rejected: 0
  };
  const PAGE_SIZE = 20;
  const EMAIL_SUBJECT_MAX_LENGTH = 180;
  const EMAIL_BODY_MAX_LENGTH = 100000;

  function toUiStatus(value) {
    const raw = String(value || "").trim().toLowerCase();
    const map = {
      new: "New",
      interviewed: "Interviewed",
      interviewing: "Interviewed",
      selected: "Selected",
      rejected: "Rejected",
      pending: "Pending"
    };
    return map[raw] || value || "";
  }

  function toDbStatus(value) {
    return String(value || "").trim().toLowerCase();
  }

  function formatExperience(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function formatCtc(value) {
    if (value === null || value === undefined || value === "") return "";
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const lpa = num > 100000 ? num / 100000 : num;
    return `${Math.round(lpa * 10) / 10} LPA`;
  }

  function formatDisplayDate(value) {
    if (!value) return "";
    return new Date(value).toLocaleDateString();
  }

  function replacePlaceholders(template, candidate) {
    const company = appConfig.company_name || "Company";
    const replacements = {
      "{{name}}": candidate.name || "",
      "{{role}}": candidate.role || "",
      "{{position}}": candidate.role || "",
      "{{company_name}}": company,
      "{{company}}": company
    };

    return Object.entries(replacements).reduce((content, [needle, replacement]) => {
      return content.split(needle).join(replacement);
    }, template || "");
  }

  function sanitizeEmailContent(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  async function createSignedUrl(storagePath) {
    if (!storagePath) return "";

    const { data, error } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 1800);

    if (error) return "";
    return data?.signedUrl || "";
  }

  async function loadConfig() {
    const { data, error } = await supabaseClient
      .from("app_config")
      .select("company_name, company_logo_url")
      .eq("tenant_id", TENANT_ID)
      .maybeSingle();

    if (error) throw error;

    appConfig = data || {};

    if (appConfig.company_name) {
      document.getElementById("companyName").innerText = appConfig.company_name;
    }

    if (appConfig.company_logo_url) {
      document.getElementById("companyLogo").src = appConfig.company_logo_url;
    }
  }

  async function loadClients() {
    const { data, error } = await supabaseClient
      .from("clients")
      .select("id, client_name")
      .eq("tenant_id", TENANT_ID)
      .eq("is_active", true)
      .order("client_name", { ascending: true });

    if (error) throw error;

    const dropdown = document.getElementById("clientSelect");
    dropdown.innerHTML = `<option value="">Select Client</option>`;
    clientsById = {};

    (data || []).forEach((client) => {
      clientsById[client.id] = client.client_name;
      const opt = document.createElement("option");
      opt.value = client.id;
      opt.textContent = client.client_name;
      dropdown.appendChild(opt);
    });
  }

  async function loadCandidateClientMap() {
    const { data, error } = await supabaseClient
      .from("client_submissions")
      .select("candidate_id, client_id")
      .eq("tenant_id", TENANT_ID);

    if (error) throw error;

    candidateClientMap = {};
    candidateClientIdMap = {};

    (data || []).forEach((row) => {
      const clientName = clientsById[row.client_id] || row.client_id;

      if (!candidateClientMap[row.candidate_id]) candidateClientMap[row.candidate_id] = [];
      if (!candidateClientIdMap[row.candidate_id]) candidateClientIdMap[row.candidate_id] = [];

      candidateClientMap[row.candidate_id].push(clientName);
      candidateClientIdMap[row.candidate_id].push(row.client_id);
    });
  }

  async function loadCandidates() {
    const searchTerm = (document.getElementById("searchInput")?.value || "").trim();
    const statusFilter = document.getElementById("statusFilter")?.value || "All";
    const roleFilter = document.getElementById("roleFilter")?.value || "All";

    let query = supabaseClient
      .from("candidates")
      .select(`
        id,
        name,
        email,
        phone,
        role,
        experience_text,
        location,
        resume_storage_path,
        status,
        applied_at,
        created_at,
        current_ctc,
        expected_ctc,
        notice_period
      `, { count: "exact" })
      .eq("tenant_id", TENANT_ID)
      .order("created_at", { ascending: false });

    if (searchTerm) {
      const escaped = searchTerm.replace(/[%_,]/g, "");
      query = query.or(`name.ilike.%${escaped}%,role.ilike.%${escaped}%,location.ilike.%${escaped}%`);
    }

    if (statusFilter !== "All") {
      query = query.eq("status", toDbStatus(statusFilter));
    }

    if (roleFilter !== "All") {
      query = query.eq("role", roleFilter);
    }

    query = query.range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1);

    const { data: candidates, error, count } = await query;

    if (error) throw error;
    totalCount = count || 0;

    if (totalCount > 0 && currentPage * PAGE_SIZE >= totalCount) {
      currentPage = Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);
      return loadCandidates();
    }

    const candidateIds = (candidates || []).map((c) => c.id);
    let docs = [];

    if (candidateIds.length) {
      const { data: docRows, error: docsError } = await supabaseClient
        .from("candidate_documents")
        .select("candidate_id, storage_path")
        .eq("tenant_id", TENANT_ID)
        .eq("kind", "supporting")
        .in("candidate_id", candidateIds)
        .order("created_at", { ascending: true });

      if (docsError) throw docsError;
      docs = docRows || [];
    }

    const docsByCandidate = {};
    docs.forEach((doc) => {
      if (!docsByCandidate[doc.candidate_id]) docsByCandidate[doc.candidate_id] = [];
      docsByCandidate[doc.candidate_id].push(doc.storage_path);
    });

    const rows = [];

    for (const row of candidates || []) {
      const resumeUrl = await createSignedUrl(row.resume_storage_path);
      const otherDocLinks = [];

      for (const path of docsByCandidate[row.id] || []) {
        const signed = await createSignedUrl(path);
        if (signed) otherDocLinks.push(signed);
      }

      rows.push({
        candidate_id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone || "",
        role: row.role,
        experience: formatExperience(row.experience_text),
        location: row.location || "",
        resume_path: row.resume_storage_path || "",
        resume_url: resumeUrl,
        status: toUiStatus(row.status),
        applied_at: row.applied_at || "",
        created_at: row.created_at || "",
        applied_date: formatDisplayDate(row.applied_at),
        other_docs: otherDocLinks.join(","),
        current_ctc: formatCtc(row.current_ctc),
        expected_ctc: formatCtc(row.expected_ctc),
        notice_period: row.notice_period || ""
      });
    }

    return rows;
  }

  function buildCandidateCountQuery(statusOverride = null) {
    const searchTerm = (document.getElementById("searchInput")?.value || "").trim();
    const statusFilter = document.getElementById("statusFilter")?.value || "All";
    const roleFilter = document.getElementById("roleFilter")?.value || "All";

    let query = supabaseClient
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", TENANT_ID);

    if (searchTerm) {
      const escaped = searchTerm.replace(/[%_,]/g, "");
      query = query.or(`name.ilike.%${escaped}%,role.ilike.%${escaped}%,location.ilike.%${escaped}%`);
    }

    if (roleFilter !== "All") {
      query = query.eq("role", roleFilter);
    }

    if (statusOverride) {
      query = query.eq("status", statusOverride);
    } else if (statusFilter !== "All") {
      query = query.eq("status", toDbStatus(statusFilter));
    }

    return query;
  }

  async function loadFilteredSummary() {
    const selectedStatus = document.getElementById("statusFilter")?.value || "All";

    const totalPromise = buildCandidateCountQuery();

    const interviewedPromise =
      selectedStatus !== "All" && selectedStatus !== "Interviewed"
        ? Promise.resolve({ count: 0, error: null })
        : buildCandidateCountQuery("interviewed");

    const selectedPromise =
      selectedStatus !== "All" && selectedStatus !== "Selected"
        ? Promise.resolve({ count: 0, error: null })
        : buildCandidateCountQuery("selected");

    const rejectedPromise =
      selectedStatus !== "All" && selectedStatus !== "Rejected"
        ? Promise.resolve({ count: 0, error: null })
        : buildCandidateCountQuery("rejected");

    const [totalRes, interviewedRes, selectedRes, rejectedRes] = await Promise.all([
      totalPromise,
      interviewedPromise,
      selectedPromise,
      rejectedPromise
    ]);

    [totalRes, interviewedRes, selectedRes, rejectedRes].forEach((result) => {
      if (result?.error) throw result.error;
    });

    filteredSummary = {
      total: totalRes.count || 0,
      interviewed: interviewedRes.count || 0,
      selected: selectedRes.count || 0,
      rejected: rejectedRes.count || 0
    };
  }

  function updatePaginationUi() {
    const pageInfo = document.getElementById("pageInfo");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    if (pageInfo) {
      if (totalCount === 0) {
        pageInfo.innerText = "Showing 0-0 of 0";
      } else {
        const start = currentPage * PAGE_SIZE + 1;
        const end = Math.min((currentPage + 1) * PAGE_SIZE, totalCount);
        pageInfo.innerText = `Showing ${start}-${end} of ${totalCount}`;
      }
    }

    if (prevBtn) {
      prevBtn.disabled = currentPage === 0;
    }

    if (nextBtn) {
      nextBtn.disabled = (currentPage + 1) * PAGE_SIZE >= totalCount;
    }

    console.log({
      page: currentPage,
      start: currentPage * PAGE_SIZE
    });
  }

  async function refreshCandidates() {
    await loadFilteredSummary();
    allCandidates = await loadCandidates();
    window.populateRoles(allCandidates);
    updatePaginationUi();
  }

  async function previewEmail(candidateId, status) {
    const candidate = allCandidates.find((c) => c.candidate_id === candidateId);
    if (!candidate) throw new Error("Candidate not found");

    const { data, error } = await supabaseClient
      .from("email_templates")
      .select("id, subject, body_html")
      .eq("tenant_id", TENANT_ID)
      .eq("trigger_status", toDbStatus(status))
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return {
        template_id: null,
        subject: `[No Template] Status: ${status}`,
        body_html: `Please create a template for '<b>${status}</b>' in email_templates.`
      };
    }

    let body = replacePlaceholders(data.body_html, candidate);
    const subject = replacePlaceholders(data.subject, candidate);

    if (appConfig.company_logo_url) {
      body = `
        <div style="text-align:center; margin-bottom:20px;">
          <img src="${appConfig.company_logo_url}" style="max-width:180px; height:auto;">
        </div>
      ` + body;
    }

    return { template_id: data.id || null, subject, body_html: body };
  }

  async function sendStatusEmail(candidate, subject, html) {
    const response = await fetch("/.netlify/functions/send-email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        to: candidate.email,
        subject,
        html
      })
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.error) {
      throw new Error(payload.error || "Email send failed");
    }

    return payload;
  }

  async function logEmailResult({ candidate, subject, html, status, errorMessage }) {
    const { error } = await supabaseClient
      .from("email_logs")
      .insert({
        tenant_id: TENANT_ID,
        candidate_id: candidate.candidate_id,
        template_id: currentTemplateId,
        recipient_email: candidate.email,
        subject,
        body_html: html,
        status,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        error_message: errorMessage || null
      });

    if (error) {
      console.error("Failed to write email log", error);
    }
  }

  async function loadCandidateHistory(candidateId) {
    const { data, error } = await supabaseClient
      .from("client_submissions")
      .select("client_id, status, exported_at, client_action_at")
      .eq("tenant_id", TENANT_ID)
      .eq("candidate_id", candidateId)
      .order("exported_at", { ascending: false });

    if (error) throw error;

    return (data || []).map((row) => ({
      client: clientsById[row.client_id] || row.client_id,
      status: toUiStatus(row.status),
      exported_at: formatDisplayDate(row.exported_at),
      action_at: formatDisplayDate(row.client_action_at)
    }));
  }

  async function loadExportLogs() {
    const { data, error } = await supabaseClient
      .from("client_submissions")
      .select("candidate_name, candidate_role, client_id, status, exported_at, client_action_at")
      .eq("tenant_id", TENANT_ID)
      .order("exported_at", { ascending: false });

    if (error) throw error;

    return (data || []).map((row) => ({
      candidate_name: row.candidate_name,
      role: row.candidate_role,
      client_name: clientsById[row.client_id] || row.client_id,
      status: toUiStatus(row.status),
      exported_at: formatDisplayDate(row.exported_at),
      action_at: formatDisplayDate(row.client_action_at)
    }));
  }

  window.applyFilters = async function applyFilters() {
    currentPage = 0;
    await refreshCandidates();
    window.renderDashboard(allCandidates);
  };

  window.nextPage = async function nextPage() {
    if ((currentPage + 1) * PAGE_SIZE >= totalCount) return;
    currentPage += 1;
    await refreshCandidates();
    window.renderDashboard(allCandidates);
  };

  window.prevPage = async function prevPage() {
    if (currentPage === 0) return;
    currentPage -= 1;
    await refreshCandidates();
    window.renderDashboard(allCandidates);
  };

  window.renderDashboard = function renderDashboard(data) {
    document.getElementById("kpi-total").innerText = filteredSummary.total;
    document.getElementById("kpi-interviewed").innerText = filteredSummary.interviewed;
    document.getElementById("kpi-selected").innerText = filteredSummary.selected;
    document.getElementById("kpi-rejected").innerText = filteredSummary.rejected;

    const tbody = document.getElementById("rows");
    tbody.innerHTML = "";

    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:20px;">No candidates found.</td></tr>';
      return;
    }

    data.forEach((c) => {
      let pdfBtn = '<span style="color:#cbd5e1; font-size:12px;">No PDF</span>';
      if ((c.resume_url || "").length > 5) {
        pdfBtn = `<a href="${c.resume_url}" target="_blank" class="btn-pdf"><i class="ri-file-pdf-line"></i> Resume</a>`;
      }

      let otherBtn = "";
      const otherDocs = (c.other_docs || "").trim();

      if (otherDocs.length > 5) {
        const links = otherDocs
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("http"));

        if (links.length > 0) {
          otherBtn = `<div style="margin-top:6px; display:flex; gap:5px; flex-wrap:wrap;">`;
          links.forEach((l, idx) => {
            otherBtn += `<a href="${l}" target="_blank" title="View Document ${idx + 1}" style="background:#f1f5f9; padding:3px 6px; border-radius:4px; color:#64748b; text-decoration:none; font-size:10px; border:1px solid #e2e8f0;"><i class="ri-file-text-line"></i> Doc ${idx + 1}</a>`;
          });
          otherBtn += `</div>`;
        }
      }

      const selectedClient = document.getElementById("clientSelect").value;
      const disabled = candidateClientIdMap[c.candidate_id]?.includes(selectedClient);

      tbody.innerHTML += `
<tr>
  <td><input type="checkbox" class="rowCheck" value="${c.candidate_id}" ${disabled ? "disabled" : ""}></td>
  <td onclick="openProfile('${c.candidate_id}')">
    <span class="candidate-name">
      ${c.name}
      ${candidateClientMap[c.candidate_id]
        ? `<span title="Sent to: ${candidateClientMap[c.candidate_id].join(", ")}" style="margin-left:6px; background:#e0f2fe; color:#0369a1; padding:2px 6px; border-radius:6px; font-size:10px;">${candidateClientMap[c.candidate_id].length} Clients</span>`
        : ""}
      <i class="ri-eye-line"></i>
    </span>
  </td>
  <td>${c.role}</td>
  <td>${c.experience}</td>
  <td><a href="https://wa.me/91${c.phone}" target="_blank" style="color:#25D366; font-weight:600; text-decoration:none;"><i class="ri-whatsapp-line"></i> ${c.phone}</a></td>
  <td><span style="color:#64748b; font-size:13px;"><i class="ri-map-pin-line"></i> ${c.location}</span></td>
  <td>${pdfBtn} ${otherBtn}</td>
  <td><span class="status-badge ${c.status}">${c.status}</span></td>
  <td>
    <button class="btn btn-int" onclick="openModal('${c.candidate_id}', 'Interviewed')">Interview</button>
    <button class="btn btn-sel" onclick="openModal('${c.candidate_id}', 'Selected')">Select</button>
    <button class="btn btn-rej" onclick="openModal('${c.candidate_id}', 'Rejected')">Reject</button>
  </td>
</tr>`;
    });
  };

  window.openModal = async function openModal(id, status) {
    currentId = id;
    targetStatus = status;

    document.getElementById("sub").value = "Loading template...";
    document.getElementById("body").value = "";
    document.getElementById("emailPreview").innerHTML = "";
    document.getElementById("emailModal").style.display = "flex";

    const res = await previewEmail(id, status);
    currentTemplateId = res.template_id || null;
    document.getElementById("modalTitle").innerText = "Mark as " + status;
    document.getElementById("sub").value = res.subject;
    document.getElementById("body").value = res.body_html;
    document.getElementById("emailPreview").innerHTML = res.body_html;
    window.switchView("preview");
  };

  window.confirmUpdate = async function confirmUpdate() {
    if (statusUpdateInFlight) return;

    const confirmBtn = document.querySelector("#confirmBtn");
    const modal = document.getElementById("emailModal");
    const actionText = {
      Selected: "Selecting...",
      Rejected: "Rejecting...",
      Interviewed: "Updating..."
    };

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerText = actionText[targetStatus] || "Updating status & sending email...";
    }

    document.querySelectorAll(".btn").forEach((btn) => {
      btn.disabled = true;
    });

    const toggle = document.getElementById("sendToggle").checked;
    const sub = sanitizeEmailContent(document.getElementById("sub").value, EMAIL_SUBJECT_MAX_LENGTH);
    const body = sanitizeEmailContent(document.getElementById("body").value, EMAIL_BODY_MAX_LENGTH);
    const candidate = allCandidates.find((c) => c.candidate_id === currentId);

    if (modal) {
      modal.style.display = "none";
    }
    document.getElementById("rows").style.opacity = "0.5";
    document.getElementById("rows").style.pointerEvents = "none";
    statusUpdateInFlight = true;

    try {
      const { error } = await supabaseClient.rpc("update_candidate_status", {
        p_candidate_id: currentId,
        p_new_status: toDbStatus(targetStatus)
      });

      if (error) throw error;

      if (toggle && candidate?.email) {
        try {
          await sendStatusEmail(candidate, sub, body);
          await logEmailResult({
            candidate,
            subject: sub,
            html: body,
            status: "sent",
            errorMessage: null
          });
        } catch (emailError) {
          await logEmailResult({
            candidate,
            subject: sub,
            html: body,
            status: "failed",
            errorMessage: emailError.message || "Email send failed"
          });
          window.showToast(emailError.message || "Email send failed", "error");
        }
      }

      await refreshCandidates();
      await loadCandidateClientMap();
      window.applyFilters();
    } catch (err) {
      window.showToast(err.message || "Status update failed", "error");
    } finally {
      statusUpdateInFlight = false;
      document.getElementById("rows").style.opacity = "1";
      document.getElementById("rows").style.pointerEvents = "auto";

      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Confirm";
      }

      document.querySelectorAll(".btn").forEach((btn) => {
        btn.disabled = false;
      });
    }
  };

  window.closeModal = function closeModal() {
    document.getElementById("emailModal").style.display = "none";
  };

  window.updatePreview = function updatePreview() {
    const content = document.getElementById("body").value;
    document.getElementById("emailPreview").innerHTML = content;
  };

  window.switchView = function switchView(mode) {
    const previewView = document.getElementById("previewView");
    const codeView = document.getElementById("codeView");
    const previewBtn = document.getElementById("previewBtn");
    const codeBtn = document.getElementById("codeBtn");

    if (mode === "preview") {
      previewView.style.display = "block";
      codeView.style.display = "none";
      previewBtn.style.background = "#1e293b";
      previewBtn.style.color = "white";
      codeBtn.style.background = "white";
      codeBtn.style.color = "#334155";
    } else {
      previewView.style.display = "none";
      codeView.style.display = "block";
      codeBtn.style.background = "#1e293b";
      codeBtn.style.color = "white";
      previewBtn.style.background = "white";
      previewBtn.style.color = "#334155";
    }
  };

  window.openProfile = async function openProfile(id) {
    const candidate = allCandidates.find((c) => c.candidate_id === id);
    if (!candidate) return;

    let ctcBlock = "";
    if (candidate.current_ctc || candidate.expected_ctc || candidate.notice_period) {
      ctcBlock = `
        <hr style="margin:15px 0;">
        <div><strong>Current CTC:</strong> ${candidate.current_ctc || "-"}</div>
        <div><strong>Expected CTC:</strong> ${candidate.expected_ctc || "-"}</div>
        <div><strong>Notice Period:</strong> ${candidate.notice_period || "-"}</div>
      `;
    }

    let docsBlock = "";
    if (candidate.resume_url) {
      docsBlock += `
        <div style="margin-top:10px;">
          <a href="${candidate.resume_url}" target="_blank" class="btn-pdf">
            <i class="ri-file-pdf-line"></i> Resume
          </a>
        </div>
      `;
    }

    if (candidate.other_docs && candidate.other_docs.trim().length > 5) {
      const links = candidate.other_docs
        .split(",")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("http"));

      if (links.length > 0) {
        docsBlock += `<div style="margin-top:15px;"><div style="font-weight:600; margin-bottom:6px;">Other Documents</div><div style="display:flex; flex-wrap:wrap; gap:6px;">`;
        links.forEach((l, idx) => {
          docsBlock += `<a href="${l}" target="_blank" class="btn" style="font-size:11px;">Doc ${idx + 1}</a>`;
        });
        docsBlock += `</div></div>`;
      }
    }

    document.getElementById("profileContent").innerHTML = `
      <div style="display:grid; grid-template-columns:150px 1fr; row-gap:10px;">
        <div><strong>Name</strong></div><div>${candidate.name}</div>
        <div><strong>Email</strong></div><div>${candidate.email}</div>
        <div><strong>Phone</strong></div><div>${candidate.phone}</div>
        <div><strong>Role</strong></div><div>${candidate.role}</div>
        <div><strong>Experience</strong></div><div>${candidate.experience}</div>
        <div><strong>Location</strong></div><div>${candidate.location}</div>
        <div><strong>Applied</strong></div><div>${candidate.applied_date}</div>
      </div>
      ${ctcBlock}
      ${docsBlock}
    `;

    const history = await loadCandidateHistory(id);
    if (history && history.length) {
      let historyHTML = `
        <hr style="margin:15px 0;">
        <div style="font-weight:600; margin-bottom:8px;">Client Activity</div>
      `;

      history.forEach((h) => {
        let color = "#64748b";
        if (h.status === "Selected") color = "#15803d";
        if (h.status === "Rejected") color = "#b91c1c";

        historyHTML += `
          <div style="margin-bottom:6px; font-size:13px;">
            <strong>${h.client}</strong> →
            <span style="color:${color}; font-weight:600;">${h.status || "Exported"}</span>
            <div style="font-size:11px; color:#94a3b8;">Exported: ${h.exported_at} | Action: ${h.action_at || "-"}</div>
          </div>
        `;
      });

      document.getElementById("profileContent").innerHTML += historyHTML;
    }

    document.getElementById("profileModal").style.display = "flex";
  };

  window.closeProfile = function closeProfile() {
    document.getElementById("profileModal").style.display = "none";
  };

  window.toggleAll = function toggleAll(source) {
    document.querySelectorAll(".rowCheck").forEach((cb) => {
      cb.checked = source.checked;
    });
  };

  window.bulkExport = async function bulkExport() {
    const btn = document.getElementById("exportBtn");
    const clientId = document.getElementById("clientSelect").value;

    if (!clientId) {
      window.showToast("Select client", "error");
      return;
    }

    const selected = [...document.querySelectorAll(".rowCheck:checked")].map((c) => c.value);
    if (selected.length === 0) {
      window.showToast("No candidates selected", "error");
      return;
    }

    const alreadySent = selected.filter((id) => candidateClientIdMap[id]?.includes(clientId));
    const valid = selected.filter((id) => !candidateClientIdMap[id]?.includes(clientId));

    if (alreadySent.length > 0) {
      window.showToast(`${alreadySent.length} already sent`, "info");
    }

    if (valid.length === 0) {
      window.showToast("Nothing to export", "error");
      return;
    }

    btn.disabled = true;
    btn.innerText = `Exporting 0/${valid.length}...`;

    let completed = 0;
    let success = 0;

    try {
      for (const id of valid) {
        const candidate = allCandidates.find((c) => c.candidate_id === id);
        if (!candidate) continue;

        const { error } = await supabaseClient
          .from("client_submissions")
          .insert({
            tenant_id: TENANT_ID,
            client_id: clientId,
            candidate_id: id,
            status: "pending",
            candidate_name: candidate.name,
            candidate_role: candidate.role,
            candidate_experience_text: candidate.experience,
            candidate_location: candidate.location,
            candidate_applied_at: candidate.applied_at || new Date().toISOString(),
            resume_storage_path: candidate.resume_path || null
          });

        if (!error) {
          success++;
        } else if (error.code !== "23505") {
          throw error;
        }

        completed++;
        btn.innerText = `Exporting ${completed}/${valid.length}...`;
      }

      await loadCandidateClientMap();
      window.showToast(`Exported ${success} candidates`, "success");
      document.querySelectorAll(".rowCheck").forEach((cb) => {
        cb.checked = false;
      });
      window.applyFilters();
    } catch (err) {
      window.showToast(err.message || "Export failed", "error");
    } finally {
      btn.disabled = false;
      btn.innerText = "Export Selected";
    }
  };

  window.showToast = function showToast(msg, type = "info") {
    const toast = document.getElementById("toast");
    toast.innerText = msg;

    if (type === "success") toast.style.background = "#16a34a";
    else if (type === "error") toast.style.background = "#dc2626";
    else toast.style.background = "#1e293b";

    toast.style.display = "block";
    setTimeout(() => {
      toast.style.display = "none";
    }, 2500);
  };

  window.populateRoles = function populateRoles(data) {
    const roleFilter = document.getElementById("roleFilter");
    roleFilter.innerHTML = '<option value="All">All Roles</option>';

    const roles = [...new Set(data.map((c) => c.role).filter(Boolean))];
    roles.sort();

    roles.forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      roleFilter.appendChild(opt);
    });
  };

  window.showCandidatesView = function showCandidatesView() {
    document.querySelector(".table-container").style.display = "block";
    document.querySelector(".kpi-grid").style.display = "grid";
    document.querySelector(".controls").style.display = "flex";
    document.getElementById("exportSection").style.display = "none";
  };

  window.showExportView = function showExportView() {
    document.querySelector(".table-container").style.display = "none";
    document.querySelector(".kpi-grid").style.display = "none";
    document.querySelector(".controls").style.display = "none";
    document.getElementById("exportSection").style.display = "block";

    loadExportLogs()
      .then((data) => {
        const tbody = document.getElementById("exportRows");
        tbody.innerHTML = "";

        if (!data || data.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No export logs found.</td></tr>';
          return;
        }

        data.forEach((d) => {
          tbody.innerHTML += `
            <tr>
              <td>${d.candidate_name}</td>
              <td>${d.role}</td>
              <td>${d.client_name}</td>
              <td>${d.status}</td>
              <td>${d.exported_at}</td>
              <td>${d.action_at || "-"}</td>
            </tr>
          `;
        });
      })
      .catch((err) => window.showToast(err.message || "Failed to load exports", "error"));
  };

  window.addEventListener("click", function (event) {
    const profile = document.getElementById("profileModal");
    const email = document.getElementById("emailModal");

    if (event.target === profile) profile.style.display = "none";
    if (event.target === email) email.style.display = "none";
  });

  window.addEventListener("load", async function () {
    window.switchView("preview");

    try {
      await loadConfig();
      await loadClients();
      await refreshCandidates();
      await loadCandidateClientMap();
      window.renderDashboard(allCandidates);
    } catch (err) {
      document.getElementById("rows").innerHTML = `<tr><td colspan="8" style="color:red; text-align:center; padding:20px;">Error: ${err.message}</td></tr>`;
    }
  });
})();
