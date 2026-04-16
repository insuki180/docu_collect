(function () {
  const SUPABASE_URL = window.APP_CONFIG.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.APP_CONFIG.SUPABASE_ANON_KEY;
  const TENANT_ID = window.APP_CONFIG.TENANT_ID;
  const STORAGE_BUCKET = "candidate-files";
  const DEFAULT_CLIENT_TITLE = "Arena Dashboard";
  const DEFAULT_CLIENT_LOGO = "assets/eassyonboard-logo.png";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const PAGE_SIZE = 20;

  const clientKey = document.body.dataset.clientKey || new URLSearchParams(window.location.search).get("client") || "";
  let allData = [];
  let clientRecord = null;
  let currentPage = 0;
  let totalCount = 0;

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

  async function loadClientCandidates() {
    if (!clientRecord?.id) throw new Error("Client not loaded");

    const { data, error, count } = await supabaseClient
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
      `, { count: "exact" })
      .eq("tenant_id", TENANT_ID)
      .eq("client_id", clientRecord.id)
      .order("candidate_applied_at", { ascending: false })
      .range(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE - 1);

    if (error) throw error;
    totalCount = count || 0;

    if (totalCount > 0 && currentPage * PAGE_SIZE >= totalCount) {
      currentPage = Math.max(0, Math.ceil(totalCount / PAGE_SIZE) - 1);
      return loadClientCandidates();
    }

    const rows = [];

    for (const row of data || []) {
      rows.push({
        submission_id: row.id,
        candidate_id: row.candidate_id,
        name: row.candidate_name,
        role: row.candidate_role,
        experience: formatExperience(row.candidate_experience_text),
        resume_url: await createSignedUrl(row.resume_storage_path),
        status: toUiStatus(row.status),
        applied_at: row.candidate_applied_at || "",
        applied_date: row.candidate_applied_at ? new Date(row.candidate_applied_at).toLocaleDateString() : ""
      });
    }

    return sortCandidates(rows);
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

  window.populateRoles = function populateRoles(data) {
    const roles = [...new Set(data.map((d) => d.role).filter(Boolean))];
    const dropdown = document.getElementById("roleFilter");
    dropdown.innerHTML = '<option value="All">All Roles</option>';

    roles.forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = role;
      dropdown.appendChild(opt);
    });
  };

  window.applyFilters = function applyFilters() {
    const search = document.getElementById("search").value.toLowerCase();
    const status = document.getElementById("statusFilter").value;
    const role = document.getElementById("roleFilter").value;

    const filtered = allData.filter((d) => {
      const matchSearch =
        d.name.toLowerCase().includes(search) ||
        d.role.toLowerCase().includes(search);

      const matchStatus = status === "All" || d.status === status;
      const matchRole = role === "All" || d.role === role;

      return matchSearch && matchStatus && matchRole;
    });

    window.render(filtered);
  };

  window.refreshData = async function refreshData() {
    const tbody = document.getElementById("rows");
    tbody.innerHTML = `<tr><td colspan="6">Refreshing...</td></tr>`;
    updatePaginationUi(0);

    try {
      allData = await loadClientCandidates();
      window.applyFilters();
    } catch (err) {
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

    updatePaginationUi(data.length);
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
      await loadBranding();
      allData = await loadClientCandidates();
      window.populateRoles(allData);
      window.render(allData);
    } catch (err) {
      document.getElementById("rows").innerHTML = `<tr><td colspan="6">Error: ${err.message}</td></tr>`;
    }
  }

  document.addEventListener("DOMContentLoaded", initClientDashboard);
})();
