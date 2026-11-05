    const nicknameInput = document.getElementById("nickname");
    const passwordInput = document.getElementById("password");
    const accountResult = document.getElementById("account-result");
    const sessionResult = document.getElementById("session-result");
    const result = document.getElementById("result");
    const balanceResult = document.getElementById("balance-result");
    const databaseResult = document.getElementById("database-result");
    const conversionFileInput = document.getElementById("conversion-file");
    const tasksResult = document.getElementById("tasks-result");
    const taskList = document.getElementById("task-list");
    const convertFileButton = document.getElementById("convert-file");
    const clearSelectionButton = document.getElementById("clear-selection");
    const clearHistoryButton = document.getElementById("clear-history");
    const uploadProgressContainer = document.getElementById("upload-progress-container");
    const uploadProgress = document.getElementById("upload-progress");
    const uploadProgressText = document.getElementById("upload-progress-text");
    const selectedFileName = document.getElementById("selected-file-name");
    const selectedFileMeta = document.getElementById("selected-file-meta");
    const fileFeedback = document.getElementById("file-feedback");
    const statTotal = document.getElementById("stat-total");
    const statActive = document.getElementById("stat-active");
    const statCompleted = document.getElementById("stat-completed");
    const emptyHistory = document.getElementById("empty-history");
    const emptyHistoryMessage = document.getElementById("empty-history-message");
    const historyPagination = document.getElementById("history-pagination");
    const historyPrev = document.getElementById("history-prev");
    const historyNext = document.getElementById("history-next");
    const historyPage = document.getElementById("history-page");
    const latestTaskName = document.getElementById("latest-task-name");
    const latestTaskMeta = document.getElementById("latest-task-meta");
    const latestTaskStatus = document.getElementById("latest-task-status");
    const latestDownload = document.getElementById("latest-download");
    const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
    let currentFilter = "all";
    let currentPage = 1;
    let tasksRequestVersion = 0;
    let currentUploadTaskId = null;
    let canManageTasks = false;
    let uploadingFile = false;
    let limits = null;
    const reloadTasksButton = document.getElementById("reload-tasks");
    let taskRefreshTimer;
    const processingStages = [
      { key: "uploaded", label: "PPTX завантажено" },
      { key: "preparing", label: "Перевірка PPTX" },
      { key: "converting", label: "Конвертація PPTX у PDF" },
      { key: "saving", label: "Збереження PDF" }
    ];

    async function apiRequest(url, options = {}) {
      const response = await fetch(url, { cache: "no-store", ...options });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(response.status === 413
          ? (limits ? `Файл завеликий. Максимум ${limits.maxPptxMiB} МіБ.` : "Файл завеликий.")
          : "Некоректна відповідь сервера.");
      }

      if (!response.ok) {
        throw new Error(data.error || "Помилка сервера.");
      }

      return data;
    }

    function setUploadProgress(percent) {
      uploadProgress.firstElementChild.style.setProperty("--upload-ratio", String(percent / 100));
      uploadProgress.setAttribute("aria-valuenow", String(percent));
      uploadProgressText.textContent = percent === 100
        ? "Файл передано. Очікуємо підтвердження сервера..."
        : `Завантаження PPTX: ${percent}%`;
    }

    function uploadFile(file) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/tasks/convert");
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));

        request.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.floor(event.loaded / event.total * 100));
          }
        });

        request.addEventListener("load", () => {
          let data;
          try {
            data = JSON.parse(request.responseText);
          } catch {
            reject(new Error(request.status === 413
              ? (limits ? `Файл завеликий. Максимум ${limits.maxPptxMiB} МіБ.` : "Файл завеликий.")
              : "Некоректна відповідь сервера."));
            return;
          }
          if (request.status < 200 || request.status >= 300) {
            reject(new Error(data.error || "Помилка сервера."));
          } else {
            resolve(data);
          }
        });

        request.addEventListener("error", () => {
          reject(new Error("Не вдалося завантажити PPTX."));
        });

        request.send(file);
      });
    }

    function fileValidationError(file) {
      if (!limits) return "Не вдалося отримати ліміти сервера. Онови сторінку.";
      if (file.name.length < 6 || file.name.length > 120 || !/\.pptx$/i.test(file.name) || /[\x00-\x1f/\\]/.test(file.name)) {
        return "Обери PPTX-файл з назвою до 120 символів.";
      }
      if (file.size === 0) return "Файл порожній.";
      if (file.size > limits.maxPptxMiB * 1024 * 1024) {
        return `Файл перевищує максимальний розмір ${limits.maxPptxMiB} МіБ.`;
      }
      return "";
    }

    function updateFileButtons() {
      const file = conversionFileInput.files[0];
      const error = file ? fileValidationError(file) : "";
      selectedFileName.textContent = file ? file.name : "Обрати PPTX-файл";
      selectedFileMeta.textContent = file
        ? `${(file.size / 1024 / 1024).toFixed(2)} МіБ · ${error ? "Не може бути завантажений" : "Готовий до завантаження"}`
        : "Натисни, щоб вибрати презентацію зі свого комп'ютера";
      fileFeedback.textContent = error || (!limits ? "Не вдалося отримати ліміти сервера. Онови сторінку." : "");
      fileFeedback.hidden = !fileFeedback.textContent;
      conversionFileInput.closest(".file-picker").classList.toggle("invalid", !!error);
      convertFileButton.disabled = !canManageTasks || !file || !!error || uploadingFile;
      clearSelectionButton.disabled = !canManageTasks || !file || uploadingFile;
      conversionFileInput.disabled = !canManageTasks || !limits || uploadingFile;
    }

    async function loadLimits() {
      try {
        limits = await apiRequest("/api/config");
        document.getElementById("fact-max-pptx").textContent = `${limits.maxPptxMiB} МіБ`;
        document.getElementById("fact-max-tasks").textContent = String(limits.maxActiveTasks);
        document.getElementById("fact-timeout").textContent = `${limits.conversionTimeoutSeconds} с`;
        document.getElementById("picker-limit").textContent = `ДО ${limits.maxPptxMiB} МіБ`;
        document.getElementById("hint-max-tasks").textContent = String(limits.maxActiveTasks);
      } catch {
        limits = null;
      }
      updateFileButtons();
    }

    function setTaskAccess(allowed) {
      canManageTasks = allowed;
      document.body.classList.toggle("is-authenticated", allowed);
      reloadTasksButton.disabled = !allowed;
      clearHistoryButton.disabled = !allowed;
      if (!allowed) {
        conversionFileInput.value = "";
        uploadProgressContainer.hidden = true;
        currentUploadTaskId = null;
        clearTimeout(taskRefreshTimer);
        tasksRequestVersion++;
        currentPage = 1;
        historyPagination.hidden = true;
        taskList.replaceChildren();
        emptyHistory.hidden = true;
        statTotal.textContent = "—";
        statActive.textContent = "—";
        statCompleted.textContent = "—";
        tasksResult.textContent = "Увійдіть, щоб переглянути задачі.";
        latestTaskName.textContent = "Задач поки немає";
        latestTaskMeta.textContent = "Після запуску тут з'явиться стан останньої задачі.";
        latestTaskStatus.textContent = "Увійди, щоб побачити свої задачі.";
        latestDownload.hidden = true;
        latestDownload.removeAttribute("href");
      }
      updateFileButtons();
    }

    function updateTaskProgress(item, task) {
      const completed = task.status === "completed";
      const queued = task.status === "queued";
      const foundIndex = processingStages.findIndex((stage) => stage.key === task.processing_stage);
      const currentIndex = foundIndex === -1 ? 1 : foundIndex;
      const stageText = completed ? "Готово — усі етапи завершено"
        : queued ? "Файл завантажено — очікує вільного worker"
        : processingStages[currentIndex].label;
      const bar = item.querySelector(".task-progress");
      const description = item.querySelector(".task-stage");

      bar.setAttribute("aria-label", `Задача ${task.id}: ${stageText}`);
      bar.setAttribute("aria-valuetext", stageText);
      description.textContent = stageText;

      for (let i = 0; i < processingStages.length; i++) {
        const segment = bar.children[i];
        segment.classList.toggle("done", completed || (queued ? i === 0 : i < currentIndex));
        segment.classList.toggle("current", !completed && !queued && i === currentIndex);
      }
    }

    function updateLatestTask(tasks) {
      const task = tasks[0];
      latestDownload.hidden = true;
      latestDownload.removeAttribute("href");

      if (!task) {
        latestTaskName.textContent = "Задач поки немає";
        latestTaskMeta.textContent = "Обери презентацію та запусти конвертацію.";
        latestTaskStatus.textContent = "Нові задачі з'являться тут.";
        return;
      }

      const statuses = {
        draft: "Це незавершена чернетка зі старої версії.",
        queued: "Файл завантажено. Задача очікує в черзі.",
        processing: "Конвертація триває. Етапи виконання є в історії.",
        completed: "Готово. PDF можна завантажити.",
        failed: "Конвертація завершилася помилкою.",
        cancelled: "Задачу скасовано."
      };

      latestTaskName.textContent = task.source_filename;
      latestTaskMeta.textContent = `Задача #${task.id}` +
        (task.file_size_bytes ? ` · ${(task.file_size_bytes / 1024 / 1024).toFixed(2)} МіБ` : "");
      latestTaskStatus.textContent = task.status === "failed" && task.error_message
        ? `Помилка: ${task.error_message}`
        : statuses[task.status] || "Стан задачі невідомий.";

      if (task.status === "completed" && task.has_output) {
        latestDownload.href = `/api/tasks/${task.id}/download`;
        latestDownload.hidden = false;
      }
    }

    async function loadTasks() {
      clearTimeout(taskRefreshTimer);
      const requestVersion = ++tasksRequestVersion;
      const requestedPage = currentPage;
      const requestedFilter = currentFilter;
      if (taskList.children.length === 0) {
        tasksResult.textContent = "Завантажуємо історію...";
      }
      try {
        const data = await apiRequest(`/api/tasks?page=${requestedPage}&filter=${requestedFilter}`);
        if (!canManageTasks || requestVersion !== tasksRequestVersion) return;
        const pageCount = Math.max(1, Math.ceil(data.filteredCount / data.pageSize));
        if (currentPage > pageCount) {
          currentPage = pageCount;
          await loadTasks();
          return;
        }
        updateLatestTask(data.latestTask ? [data.latestTask] : []);
        historyPagination.hidden = pageCount <= 1;
        historyPrev.disabled = currentPage === 1;
        historyNext.disabled = currentPage >= pageCount;
        historyPage.textContent = `Сторінка ${currentPage} із ${pageCount}`;
        if (currentUploadTaskId !== null) {
          const trackedTask = data.tasks.find((task) => String(task.id) === String(currentUploadTaskId)) ||
            (String(data.latestTask?.id) === String(currentUploadTaskId) ? data.latestTask : null);
          if (!trackedTask && requestedPage === 1 && requestedFilter === "all") {
            uploadProgressContainer.hidden = true;
            currentUploadTaskId = null;
          } else if (trackedTask && ["queued", "processing", "completed"].includes(trackedTask.status)) {
            updateTaskProgress(uploadProgressContainer, trackedTask);
          } else if (trackedTask) {
            uploadProgressText.textContent = trackedTask.status === "failed"
              ? "Обробка завершилася помилкою. Деталі є в історії."
              : "Задачу скасовано.";
            for (const segment of uploadProgress.children) {
              segment.classList.remove("current");
            }
          }
        }
        const previousItems = Array.from(taskList.children);
        const nextItems = [];
        statTotal.textContent = String(data.stats.total);
        statActive.textContent = String(data.stats.active);
        statCompleted.textContent = String(data.stats.completed);
        const visibleTasks = data.tasks;

        for (const task of visibleTasks) {
          const signature = [task.status, task.has_file, task.has_output,
            task.worker_name, task.error_message, task.file_size_bytes].join("|");
          const previousItem = previousItems.find((item) => item.dataset.taskId === String(task.id));

          if (previousItem && previousItem.dataset.signature === signature) {
            if (task.status === "processing") {
              updateTaskProgress(previousItem, task);
            }
            nextItems.push(previousItem);
            continue;
          }

          const item = document.createElement("li");
          item.dataset.taskId = String(task.id);
          item.dataset.signature = signature;
          const names = {
            draft: "Чернетка",
            queued: "У черзі",
            processing: "Виконується",
            completed: "Завершено",
            failed: "Помилка",
            cancelled: "Скасовано"
          };
          const head = document.createElement("div");
          head.className = "task-head";
          const identity = document.createElement("div");
          identity.className = "task-identity";
          const id = document.createElement("span");
          id.className = "task-id";
          id.textContent = `Задача #${task.id}`;
          const filename = document.createElement("strong");
          filename.className = "task-name";
          filename.textContent = task.source_filename;
          identity.append(id, filename);
          if (task.worker_name) {
            const worker = document.createElement("div");
            worker.className = "task-worker";
            worker.textContent = `Worker: ${task.worker_name}`;
            identity.append(worker);
          }
          const status = document.createElement("span");
          status.className = `status-pill status-${task.status}`;
          status.textContent = names[task.status] || task.status;
          head.append(identity, status);
          item.append(head);
          const actions = document.createElement("div");
          actions.className = "task-actions";

          if (["queued", "processing", "completed"].includes(task.status)) {
            const bar = document.createElement("div");
            bar.className = "task-progress";
            bar.setAttribute("role", "progressbar");

            for (let i = 0; i < processingStages.length; i++) {
              const segment = document.createElement("span");
              segment.className = "task-progress-step";
              bar.append(segment);
            }

            const description = document.createElement("p");
            description.className = "task-stage";
            item.append(bar, description);
            updateTaskProgress(item, task);
          }

          if (task.status === "completed" && task.has_output) {
            const link = document.createElement("a");
            link.className = "button button-primary button-small download-link";
            link.href = `/api/tasks/${task.id}/download`;
            link.textContent = "Завантажити PDF";
            actions.append(link);
          }

          if (task.status === "failed" && task.error_message) {
            const errorInfo = document.createElement("p");
            errorInfo.className = "task-error";
            errorInfo.textContent = task.error_message;
            item.append(errorInfo);
          }

          if (task.status === "draft") {
            const details = document.createElement("p");
            details.className = "task-note";
            details.textContent = "Незавершена чернетка зі старої версії.";
            item.append(details);
          }

          if (["queued", "processing"].includes(task.status)) {
            const cancelButton = document.createElement("button");
            cancelButton.type = "button";
            cancelButton.className = "button button-secondary button-small";
            cancelButton.textContent = "Скасувати";
            cancelButton.addEventListener("click", async () => {
              cancelButton.disabled = true;
              try {
                await apiRequest(`/api/tasks/${task.id}/cancel`, { method: "POST" });
                await loadTasks();
              } catch (error) {
                tasksResult.textContent = error.message;
                cancelButton.disabled = false;
              }
            });
            actions.append(cancelButton);
          }

          if (["draft", "completed", "failed", "cancelled"].includes(task.status)) {
            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "button button-outline button-small";
            deleteButton.textContent = "Видалити";
            deleteButton.addEventListener("click", async () => {
              if (!confirm(`Видалити задачу #${task.id} та всі пов'язані файли?`)) {
                return;
              }
              deleteButton.disabled = true;
              try {
                await apiRequest(`/api/tasks/${task.id}`, { method: "DELETE" });
                await loadTasks();
              } catch (error) {
                tasksResult.textContent = error.message;
                deleteButton.disabled = false;
              }
            });
            actions.append(deleteButton);
          }

          if (actions.children.length) item.append(actions);
          nextItems.push(item);
        }

        for (let i = 0; i < nextItems.length; i++) {
          if (taskList.children[i] !== nextItems[i]) {
            taskList.insertBefore(nextItems[i], taskList.children[i] || null);
          }
        }
        for (const oldItem of previousItems) {
          if (!nextItems.includes(oldItem)) {
            oldItem.remove();
          }
        }

        emptyHistory.hidden = visibleTasks.length > 0;
        emptyHistoryMessage.textContent = data.stats.total
          ? "Немає задач із таким статусом."
          : "Завантаж PPTX, щоб створити свою першу задачу.";
        const first = (currentPage - 1) * data.pageSize + 1;
        const last = Math.min(currentPage * data.pageSize, data.filteredCount);
        tasksResult.textContent = data.filteredCount
          ? `Задачі ${first}–${last} із ${data.filteredCount} · API: ${data.instance}`
          : "Задач із таким статусом немає.";

        if (data.stats.active > 0) {
          taskRefreshTimer = setTimeout(loadTasks, 1000);
        }
      } catch (error) {
        if (requestVersion === tasksRequestVersion) {
          tasksResult.textContent = error.message;
        }
      }
    }

    async function showAccount() {
      try {
        const data = await apiRequest("/api/me");
        accountResult.textContent = data.authenticated
          ? `Ви увійшли як ${data.nickname}. Відповів ${data.instance}.`
          : "Ви не авторизовані.";
        setTaskAccess(data.authenticated);
        if (data.authenticated) {
          await loadTasks();
        }
      } catch {
        accountResult.textContent = "Не вдалося перевірити сесію.";
        setTaskAccess(false);
      }
    }

    async function submitAccount(url) {
      accountResult.textContent = "Обробляємо запит...";
      try {
        const data = await apiRequest(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: nicknameInput.value, password: passwordInput.value })
        });
        passwordInput.value = "";
        accountResult.textContent = `Успішно. Ви увійшли як ${data.nickname}. Відповів ${data.instance}.`;
        setTaskAccess(true);
        await loadTasks();
      } catch (error) {
        accountResult.textContent = error.message;
      }
    }

    async function countRequests(url, total, requireAccount = false) {
      const counts = {};
      let databaseName = "";
      let nickname = "";

      for (let i = 0; i < total; i++) {
        const data = await apiRequest(url);

        if (requireAccount) {
          if (!data.authenticated) {
            throw new Error("Авторизація не збереглася.");
          }
          if (nickname && nickname !== data.nickname) {
            throw new Error("Сервери повернули різних користувачів.");
          }
          nickname = data.nickname;
        }

        if (url === "/api/database") {
          if (databaseName && databaseName !== data.database) {
            throw new Error("Сервери підключені до різних баз даних.");
          }
          databaseName = data.database;
        }

        counts[data.instance] = (counts[data.instance] || 0) + 1;
      }

      const summary = Object.entries(counts).map(([name, count]) => `${name} — ${count}`).join("; ");
      return { summary, databaseName, nickname, servers: Object.keys(counts).length };
    }

    function selectFilter(filter) {
      if (currentFilter !== filter) currentPage = 1;
      currentFilter = filter;
      for (const button of filterButtons) {
        const active = button.dataset.filter === filter;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }

    for (const button of filterButtons) {
      button.addEventListener("click", () => {
        selectFilter(button.dataset.filter);
        if (canManageTasks) loadTasks();
      });
    }

    historyPrev.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        loadTasks();
      }
    });

    historyNext.addEventListener("click", () => {
      if (!historyNext.disabled) {
        currentPage++;
        loadTasks();
      }
    });

    conversionFileInput.addEventListener("change", () => {
      uploadProgressContainer.hidden = true;
      updateFileButtons();
    });

    clearSelectionButton.addEventListener("click", () => {
      conversionFileInput.value = "";
      uploadProgressContainer.hidden = true;
      updateFileButtons();
    });

    convertFileButton.addEventListener("click", async () => {
      const file = conversionFileInput.files[0];
      if (!file) {
        return;
      }
      const error = fileValidationError(file);
      if (error) {
        updateFileButtons();
        return;
      }

      uploadingFile = true;
      currentUploadTaskId = null;
      updateFileButtons();
      uploadProgressContainer.hidden = false;
      for (const segment of uploadProgress.children) {
        segment.classList.remove("done", "current", "uploading");
      }
      uploadProgress.firstElementChild.classList.add("uploading");
      uploadProgress.setAttribute("aria-label", "Завантаження PPTX");
      uploadProgress.removeAttribute("aria-valuetext");
      uploadProgress.setAttribute("aria-valuemin", "0");
      uploadProgress.setAttribute("aria-valuemax", "100");
      setUploadProgress(0);
      tasksResult.textContent = "Завантажуємо PPTX...";
      try {
        const result = await uploadFile(file);
        currentUploadTaskId = result.taskId;
        uploadProgress.firstElementChild.classList.remove("uploading");
        uploadProgress.firstElementChild.classList.add("done");
        uploadProgress.removeAttribute("aria-valuenow");
        uploadProgress.removeAttribute("aria-valuemin");
        uploadProgress.removeAttribute("aria-valuemax");
        uploadProgressText.textContent = "PPTX завантажено. Очікуємо виконання задачі...";
        conversionFileInput.value = "";
        selectFilter("all");
        currentPage = 1;
        await loadTasks();
      } catch (error) {
        uploadProgressContainer.hidden = true;
        tasksResult.textContent = error.message;
      } finally {
        uploadingFile = false;
        updateFileButtons();
      }
    });

    reloadTasksButton.addEventListener("click", loadTasks);

    clearHistoryButton.addEventListener("click", async () => {
      if (!confirm("Видалити всю завершену, скасовану й помилкову історію та старі чернетки разом із файлами? Активні задачі залишаться.")) {
        return;
      }
      clearHistoryButton.disabled = true;
      try {
        const data = await apiRequest("/api/tasks/history", { method: "DELETE" });
        await loadTasks();
        tasksResult.textContent = `Видалено задач: ${data.deleted}.`;
      } catch (error) {
        tasksResult.textContent = error.message;
      } finally {
        clearHistoryButton.disabled = !canManageTasks;
      }
    });

    document.getElementById("register").addEventListener("click", () => submitAccount("/api/register"));
    document.getElementById("login").addEventListener("click", () => submitAccount("/api/login"));

    document.getElementById("logout").addEventListener("click", async () => {
      try {
        await apiRequest("/api/logout", { method: "POST" });
        passwordInput.value = "";
        accountResult.textContent = "Ви вийшли з акаунта.";
        sessionResult.textContent = "";
        setTaskAccess(false);
      } catch {
        accountResult.textContent = "Не вдалося вийти з акаунта.";
      }
    });

    document.getElementById("check-session").addEventListener("click", async () => {
      sessionResult.textContent = "Перевіряємо сесію...";
      try {
        const data = await countRequests("/api/me", 10, true);
        sessionResult.textContent = data.servers >= 2
          ? `Сесія працює на двох API. Користувач ${data.nickname}: ${data.summary}.`
          : `Сесія активна, але відповів лише один API: ${data.summary}. Перевір балансування.`;
      } catch (error) {
        sessionResult.textContent = error.message;
      }
    });

    document.getElementById("check-server").addEventListener("click", async () => {
      try {
        const data = await apiRequest("/api/health");
        result.textContent = `З'єднання працює. Відповів ${data.instance} (порт ${data.port}).`;
      } catch {
        result.textContent = "Не вдалося отримати відповідь від сервера.";
      }
    });

    document.getElementById("check-balance").addEventListener("click", async () => {
      try {
        const data = await countRequests("/api/health", 10);
        balanceResult.textContent = data.servers >= 2
          ? `Обидва API відповіли: ${data.summary}.`
          : `Увага: відповів тільки один API (${data.summary}). Перевір api1, api2 і Nginx.`;
      } catch {
        balanceResult.textContent = "Не вдалося перевірити балансування.";
      }
    });

    document.getElementById("check-database").addEventListener("click", async () => {
      try {
        const data = await countRequests("/api/database", 6);
        databaseResult.textContent = data.servers >= 2
          ? `База ${data.databaseName} доступна з обох API. ${data.summary}.`
          : `База ${data.databaseName} доступна, але відповів лише один API: ${data.summary}.`;
      } catch {
        databaseResult.textContent = "Не вдалося перевірити PostgreSQL.";
      }
    });

    loadLimits().then(showAccount);
