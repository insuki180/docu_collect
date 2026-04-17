(function () {
  const SUPABASE_URL = window.APP_CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.APP_CONFIG.SUPABASE_ANON_KEY;
  const TENANT_ID = window.APP_CONFIG.TENANT_ID;
  const STORAGE_BUCKET = "candidate-files";
  const DEFAULT_CLIENT_TITLE = "Arena Dashboard";
  const DEFAULT_CLIENT_LOGO = "assets/eassyonboard-logo.png";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const PAGE_SIZE = 20;
  const DEFAULT_FILTERS = {
    search: "",
    status: "All",
    role: "All",
    experiences: ["__all__"],
    sort: "default"
  };

  const clientKey = document.body.dataset.clientKey || new URLSearchParams(window.location.search).get("client") || "";
  let allData = [];
  let clientRecord = null;
  let currentPage = 0;
  let totalCount = 0;
  let availableRoles = [];
  let availableExperiences = [];
  let draftFilters = { ...DEFAULT_FILTERS };
  let appliedFilters = { ...DEFAULT_FILTERS };

  function toUiStatus(value) {
    const raw = String(value || "").trim().toLowerCase();
    const map = {
      pending: "Pending",
      selected: "Selected",
      rejected: "Rejected"
    };
    return map[raw] || value || "";
  }

  function formatExperience(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function parseExperienceValue(value) {
    const text = String(value || "").trim().toLowerCase();
    const matches = text.match(/(\d+(\.\d+)?)/g);
    if (!matches || matches.length === 0) return 0;
    return Math.max(...matches.map(Number));
  }

  function normalizeExperienceSelection(values) {
    if (!Array.isArray(values) || values.length === 0 || values.includes("__all__")) {
      return ["__all__"];
    }
    return [...new Set(values)];
  }

  function getExperienceButtonLabel(values) {
    const normalized = normalizeExperienceSelection(values);
    if (normalized.includes("__all__")) return "Experience: All";
    if (normalized.length === 1) return `Experience: ${normalized[0]}`;
    return `Experience: ${normalized.length} selected`;
  }

  async function createSignedUrl(storagePath) {
    if (!storagePath) return "";

    const { data, error } = await supabaseClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, 1800);

    if (error) return "";
    return data?.signedUrl || "";
  }

  function sortCandidates(data) {
    const order = {
      Selected: 1,
      Pending: 2,
      Rejected: 3
    };

    return data.sort((a, b) => {
      if (order[a.status] !== order[b.status]) {
        return order[a.status] - order[b.status];
      }

      return new Date(b.applied_at || 0) - new Date(a.applied_at || 0);
    });
  }

  function renderRoleOptions() {
    const dropdown = document.getElementById("roleFilter");
    if (!dropdown) return;

    const currentValue = dropdown.value || draftFilters.role || "All";
    dropdown.innerHTML = '<option value="All">All Roles</option>';

    availableRoles.forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      dropdown.appendChild(opt);
    });

    dropdown.value = availableRoles.includes(currentValue) ? currentValue : "All";
  }

  function readExperienceSelections() {
    const inputs = [...document.querySelectorAll('#experienceFilterMenu input[type="checkbox"]')];
    const values = inputs.filter((input) => input.checked).map((input) => input.value);
    return normalizeExperienceSelection(values);
  }

  function writeExperienceSelections(values) {
    const normalized = normalizeExperienceSelection(values);
    const inputs = [...document.querySelectorAll('#experienceFilterMenu input[type="checkbox"]')];
    inputs.forEach((input) => {
      if (input.value === "__all__") {
        input.checked = normalized.includes("__all__");
      } else {
        input.checked = !normalized.includes("__all__") && normalized.includes(input.value);
      }
    });

    const button = document.getElementById("experienceFilterButton");
    if (button) {
      button.textContent = getExperienceButtonLabel(normalized);
    }
  }

  function renderExperienceOptions() {
    const container = document.getElementById("experienceOptions");
    if (!container) return;

    container.innerHTML = "";
    availableExperiences.forEach((value) => {
      const label = document.createElement("label");
      label.className = "flex items-center gap-2 px-1 py-2 text-sm text-slate-700";
      label.innerHTML = `<input type="checkbox" value="${value}"><span>${value}</span>`;
      container.appendChild(label);
    });

    writeExperienceSelections(draftFilters.experiences);
  }

  function writeFiltersToControls(filters) {
    const normalized = { ...filters, experiences: normalizeExperienceSelection(filters.experiences) };
    const searchEl = document.getElementById("search");
    const statusEl = document.getElementById("statusFilter");
    const roleEl = document.getElementById("roleFilter");
    const sortEl = document.getElementById("sortFilter");

    if (searchEl) searchEl.value = normalized.search;
    if (statusEl) statusEl.value = normalized.status;
    if (roleEl) roleEl.value = availableRoles.includes(normalized.role) ? normalized.role : "All";
    if (sortEl) sortEl.value = normalized.sort;
    writeExperienceSelections(normalized.experiences);
  }

  function syncDraftFiltersFromControls() {
    draftFilters = {
      search: document.getElementById("search")?.value || "",
      status: document.getElementById("statusFilter")?.value || "All",
      role: document.getElementById("roleFilter")?.value || "All",
      experiences: readExperienceSelections(),
      sort: document.getElementById("sortFilter")?.value || "default"
    };
  }

  function bindExperienceMenu() {
    const button = document.getElementById("experienceFilterButton");
    const menu = document.getElementById("experienceFilterMenu");
    if (!button || !menu) return;

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.classList.toggle("hidden");
    });

    document.addEventListener("click", (event) => {
      if (!menu.contains(event.target) && event.target !== button) {
        menu.classList.add("hidden");
      }
    });

    menu.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;

      const inputs = [...menu.querySelectorAll('input[type="checkbox"]')];
      if (target.value === "__all__") {
        if (target.checked) {
          inputs.forEach((input) => {
            if (input.value !== "__all__") input.checked = false;
          });
        } else if (!inputs.some((input) => input.value !== "__all__" && input.checked)) {
          target.checked = true;
        }
      } else {
        const allInput = inputs.find((input) => input.value === "__all__");
        if (target.checked && allInput) allInput.checked = false;
        if (!inputs.some((input) => input.value !== "__all__" && input.checked) && allInput) {
          allInput.checked = true;
        }
      }

      syncDraftFiltersFromControls();
      writeExperienceSelections(readExperienceSelections());
    });
  }

  async function loadBranding() {
    const { data, error } = await supabaseClient
      .from("clients")
      .select("id, dashboard_title, logo_url")
      .eq("tenant_id", TENANT_ID)
      .eq("client_key", clientKey)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("Invalid client link");

    clientRecord = data;

    const title = data.dashboard_title || DEFAULT_CLIENT_TITLE;
    const logo = data.logo_url || DEFAULT_CLIENT_LOGO;
    const nameEl = document.getElementById("companyName");
    const logoEl = document.getElementById("companyLogo");
    const visibleNameEl = document.getElementById("visibleCompanyName");
    const visibleLogoEl = document.getElementById("visibleCompanyLogo");
    const faviconEl = document.getElementById("appFavicon");

    document.title = title;

    if (nameEl) nameEl.innerText = title;
    if (visibleNameEl) visibleNameEl.innerText = title;
    if (logoEl) logoEl.src = logo;
    if (visibleLogoEl) visibleLogoEl.src = logo;
    if (faviconEl) faviconEl.href = logo;
  }

  async function loadFilterOptions() {
    if (!clientRecord?.id) return;

    const { data, error } = await supabaseClient
      .from("client_submissions")
      .select("candidate_role, candidate_experience_text")
      .eq("tenant_id", TENANT_ID)
      .eq("client_id", clientRecord.id);

    if (error) throw error;

    availableRoles = [...new Set((data || []).map((row) => row.candidate_role).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    availableExperiences = [...new Set((data || []).map((row) => row.candidate_experience_text).filter(Boolean))]
      .sort((a, b) => parseExperienceValue(b) - parseExperienceValue(a) || String(a).localeCompare(String(b)));

    renderRoleOptions();
    renderExperienceOptions();
  }

  async function loadClientCandidates() {
    if (!clientRecord?.id) throw new Error("Client not loaded");

    const search = appliedFilters.search.trim();
    const status = appliedFilters.status;
    const role = appliedFilters.role;
    const experiences = normalizeExperienceSelection(appliedFilters.experiences);
    const sort = appliedFilters.sort;

    let query = supabaseClient
      .from("client_submissions")
      .select(`
        id,
        candidate_id,
        candidate_name,
        candidate_role,
        candidate_experience_text,
        candidate_applied_at,
        resume_storage_path,
        status
      `)
      .eq("tenant_id", TENANT_ID)
      .eq("client_id", clientRecord.id);

    if (search) {
      const escaped = search.replace(/[%_,]/g, "");
      query = query.or(`candidate_name.ilike.%${escaped}%,candidate_role.ilike.%${escaped}%`);
    }

    if (status !== "All") {
      query = query.eq("status", status.toLowerCase());
    }

    if (role !== "All") {
      query = query.eq("candidate_role", role);
    }

    if (!experiences.includes("__all__")) {
      query = query.in("candidate_experience_text", experiences);
    }

    const { data, error } = await query.order("candidate_applied_at", { ascending: false });

    if (error) throw error;

    let filteredRows = [...(data || [])];
    totalCount = filteredRows.length;

    if (sort === "experience_desc") {
      filteredRows.sort((a, b) => {
        const diff = parseExperienceValue(b.candidate_experience_text) - parseExperienceValue(a.candidate_experience_text);
        if (diff !== 0) return diff;
        return new Date(b.candidate_applied_at || 0) - new Date(a.candidate_applied_at || 0);
      });
    } else {
      filteredRows = sortCandidates(filteredRows.map((row) => ({
        status: toUiStatus(row.status),
        applied_at: row.candidate_applied_at,
        raw: row
      }))).map((entry) => entry.raw);
    }

    if (totalCount > 0 && currentPage * PAGE_SIZE >= totalCount) {
      currentPage = Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);
    }

    const pagedRows = filteredRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const rows = await Promise.all(pagedRows.map(async (row) => ({
        submission_id: row.id,
        candidate_id: row.candidate_id,
        name: row.candidate_name,
        role: row.candidate_role,
        experience: formatExperience(row.candidate_experience_text),
        resume_url: await createSignedUrl(row.resume_storage_path),
        status: toUiStatus(row.status),
        applied_at: row.candidate_applied_at || "",
        applied_date: row.candidate_applied_at ? new Date(row.candidate_applied_at).toLocaleDateString() : ""
      })));

    return rows;
  }

  function updatePaginationUi(filteredCount = null) {
    const pageInfo = document.getElementById("pageInfo");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const effectiveCount = typeof filteredCount === "number" ? filteredCount : totalCount;

    if (pageInfo) {
      if (effectiveCount === 0) {
        pageInfo.innerText = "Showing 0 of 0";
      } else {
        const start = currentPage * PAGE_SIZE + 1;
        const end = Math.min((currentPage + 1) * PAGE_SIZE, effectiveCount);
        pageInfo.innerText = `Showing ${start}-${end} of ${effectiveCount}`;
      }
    }

    if (prevBtn) {
      prevBtn.disabled = currentPage === 0;
    }

    if (nextBtn) {
      nextBtn.disabled = (currentPage + 1) * PAGE_SIZE >= effectiveCount;
    }
  }

  function setClientLoadingState(message = "Loading candidates...") {
    const tbody = document.getElementById("rows");
    const pageInfo = document.getElementById("pageInfo");
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");

    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6">${message}</td></tr>`;
    }

    if (pageInfo) {
      pageInfo.innerText = "Loading...";
    }

    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
  }

  window.populateRoles = function populateRoles() {
    renderRoleOptions();
  };

  window.applyFilters = async function applyFilters() {
    syncDraftFiltersFromControls();
    appliedFilters = {
      ...draftFilters,
      experiences: normalizeExperienceSelection(draftFilters.experiences)
    };
    currentPage = 0;
    await window.refreshData();
  };

  window.clearFilters = async function clearFilters() {
    draftFilters = { ...DEFAULT_FILTERS };
    appliedFilters = { ...DEFAULT_FILTERS };
    currentPage = 0;
    writeFiltersToControls(draftFilters);
    await window.refreshData();
  };

  window.refreshData = async function refreshData() {
    setClientLoadingState("Refreshing...");

    try {
      allData = await loadClientCandidates();
      window.render(allData);
    } catch (err) {
      const tbody = document.getElementById("rows");
      tbody.innerHTML = `<tr><td colspan="6">Failed to refresh</td></tr>`;
      updatePaginationUi(0);
    }
  };

  window.render = function render(data) {
    const tbody = document.getElementById("rows");
    tbody.innerHTML = "";

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">No candidates</td></tr>`;
      updatePaginationUi(0);
      return;
    }

    data.forEach((d) => {
      let rowClass = "";
      if (d.status === "Selected") rowClass = "selected";
      if (d.status === "Rejected") rowClass = "rejected";

      tbody.innerHTML += `
        <tr class="${rowClass}" data-id="${d.submission_id}">
          <td>${d.name}</td>
          <td>${d.role}</td>
          <td>${d.experience}</td>
          <td><a href="${d.resume_url}" target="_blank">View</a></td>
          <td><span class="status-badge ${d.status}">${d.status}</span></td>
          <td>
            ${
              d.status === "Pending"
                ? `<button class="btn btn-select" onclick="update('${d.submission_id}', '${d.candidate_id}', 'selected', this)">Select</button>
                   <button class="btn btn-reject" onclick="update('${d.submission_id}', '${d.candidate_id}', 'rejected', this)">Reject</button>`
                : `Finalized`
            }
          </td>
        </tr>
      `;
    });

    updatePaginationUi();
  };

  window.nextPage = async function nextPage() {
    if ((currentPage + 1) * PAGE_SIZE >= totalCount) return;
    currentPage += 1;
    await window.refreshData();
  };

  window.prevPage = async function prevPage() {
    if (currentPage === 0) return;
    currentPage -= 1;
    await window.refreshData();
  };

  window.update = async function update(subId, candId, status, btn) {
    const td = btn.parentElement;
    td.innerHTML = `<span style="color:#64748b; font-weight:500;">Updating... Please view next candidate</span>`;

    try {
      const { error } = await supabaseClient.rpc("update_client_submission_status", {
        p_submission_id: subId,
        p_candidate_id: candId,
        p_new_status: status
      });

      if (error) throw error;

      allData = await loadClientCandidates();
      window.applyFilters();
    } catch (err) {
      alert("Error: " + (err.message || "Update failed"));
      td.innerHTML = `Error. Please refresh.`;
    }
  };

  async function initClientDashboard() {
    if (!clientKey) {
      document.body.innerHTML = "Invalid client link";
      return;
    }

    try {
      bindExperienceMenu();
      document.getElementById("applyFiltersBtn")?.addEventListener("click", window.applyFilters);
      document.getElementById("clearFiltersBtn")?.addEventListener("click", window.clearFilters);
      await loadBranding();
      await loadFilterOptions();
      writeFiltersToControls(draftFilters);
      await window.refreshData();
    } catch (err) {
      document.getElementById("rows").innerHTML = `<tr><td colspan="6">Error: ${err.message}</td></tr>`;
    }
  }

  document.addEventListener("DOMContentLoaded", initClientDashboard);
})();
