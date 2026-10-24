(() => {
  const $ = (selector) => document.querySelector(selector);
  const form = $("#scheduleForm"), rowsRoot = $("#scheduleRows");
  const actionMenu = $("#scheduleActionMenu");
  let actionTrigger = null;
  let allSchedules = [], devices = [];
  const repeatNames = { IMMEDIATE:"즉시 실행", ONCE:"1회", HOURLY:"매시간", DAILY:"매일", WEEKLY:"반복 요일", MONTHLY:"매월", YEARLY:"매년" };
  const scheduleFilterFields = ["id","owner","device","channel","name","action","ostr","repeat","next_run","end","status","last_run","created"];
  const scheduleFilterLabels = { id:"ID", owner:"예약자", device:"디바이스", channel:"채널", name:"예약 이름", action:"동작", ostr:"OStr 문자열", repeat:"반복", next_run:"다음 실행 시각", end:"종료 시각", status:"상태", last_run:"마지막 실행", created:"등록 시각" };
  const scheduleSortFields = { id:"id", owner:"owner", device:"device", channel:"channel", name:"name", action:"action", ostr:"ostr", repeat:"repeat", next_run:"time", end:"end", status:"status", last_run:"last_run", created:"created" };
  const scheduleColumnFilters = new Map();
  const scheduleSortState = { field: "time", direction: "asc" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const formatDate = value => value ? String(value).replace("T"," ").slice(0,16) : "-";
  async function api(url, options={}) { const r=await fetch(url,{cache:"no-store",headers:{"Content-Type":"application/json",...(options.headers||{})},...options}); const data=await r.json().catch(()=>({})); if(!r.ok)throw new Error(data.error||`요청 실패 (${r.status})`); return data; }
  function setRepeatFields() {
    const type=$("#repeatType").value;
    const immediate=type==="IMMEDIATE";
    const visible={schedule_time:!immediate,end_time:type!=="ONCE"&&!immediate,weekdays:type==="WEEKLY",is_month_end:type==="MONTHLY"};
    Object.entries(visible).forEach(([key,show])=>{const el=form.querySelector(`[data-field="${key}"]`);if(el)el.hidden=!show;});
    form.elements.schedule_time.disabled=immediate;
    if(immediate)form.elements.schedule_time.value="";
    if(immediate||type==="ONCE")form.elements.end_time.value="";
    if(type!=="WEEKLY")form.querySelectorAll('input[name="weekdays"]').forEach(el=>el.checked=false);
    if(type!=="MONTHLY")form.elements.is_month_end.checked=false;
  }
  function fillSelect(select, values, firstLabel, valueKey, labelKey) { const current=select.value;select.innerHTML=`<option value="">${firstLabel}</option>`+values.map(v=>`<option value="${esc(v[valueKey])}">${esc(v[labelKey])}</option>`).join("");if([...select.options].some(o=>o.value===current))select.value=current; }
  async function loadDevices() {
    devices=(await api("/api/device/devices?include_all=1")).filter(device=>Number(device.is_enabled)===1);
    const deviceOptions=devices.map(device=>({...device,option_name:`${device.device_name}${device.is_visible==null||Number(device.is_visible)===1?"":" · Invisible"}`}));
    fillSelect($("#scheduleDevice"),deviceOptions,"디바이스 선택","device_id","option_name");
    updateChannels();
  }
  function updateChannels() {
    const device=devices.find(d=>d.device_id===$("#scheduleDevice").value);
    const channels=(device?.sets||[]).map(c=>({value:c.output_signal,label:`${c.channel_name} (${c.output_signal})${c.is_visible==null||Number(c.is_visible)===1?"":" · Invisible"}`}));
    const select=$("#scheduleChannel"), current=select.value;select.innerHTML='<option value="">채널 선택</option>'+channels.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("");if(channels.some(c=>c.value===current))select.value=current;
  }
  async function loadSchedules() {
    const data=await api("/api/device/schedules?limit=5000&sort_by=time&sort_order=asc");allSchedules=Array.isArray(data.items)?data.items:[];
    renderColumnFilters();renderTable();
  }
  function baseRows() {
    return [...allSchedules];
  }
  function scheduleColumnValue(row, field) {
    if (field === "id") return String(row.schedule_id);
    if (field === "owner") return String(row.created_by ?? "");
    if (field === "device") return String(row.device_id ?? "");
    if (field === "channel") return String(row.output_signal ?? "");
    if (field === "name") return String(row.schedule_name ?? "");
    if (field === "action") return String(row.action_state ?? "");
    if (field === "ostr") return String(row.ostr_payload ?? "");
    if (field === "repeat") return String(row.repeat_type ?? "");
    if (field === "next_run") return ["ONCE","IMMEDIATE"].includes(row.repeat_type)&&Number(row.is_enabled)!==1?"":String(row.next_run_at||row.schedule_time||"");
    if (field === "end") return String(row.end_time ?? "");
    if (field === "status") return `${row.last_execution_status||"WAITING"}|${Number(row.is_enabled)===1?1:0}`;
    if (field === "last_run") return String(row.last_run_at ?? "");
    return String(row.created_at ?? "");
  }
  function scheduleColumnLabel(row, field) {
    const value=scheduleColumnValue(row,field);
    if(field==="owner")return row.owner_name||row.owner_username||`ID ${row.created_by??"-"}`;
    if(field==="device")return `${row.device_name||row.device_id} (${row.device_id})`;
    if(field==="name")return value||"-";
    if(field==="ostr")return value||"(없음)";
    if(field==="repeat")return repeatNames[value]||value;
    if(field==="next_run"||field==="end"||field==="last_run"||field==="created")return formatDate(value);
    if(field==="status")return `${row.last_execution_status||"WAITING"}${Number(row.is_enabled)!==1?" · 비활성":" · 활성"}`;
    return value;
  }
  function applyScheduleColumnFilter(rows, field) {
    const selected=scheduleColumnFilters.get(field);
    return selected?rows.filter(row=>selected.has(scheduleColumnValue(row,field))):rows;
  }
  function currentRows() {
    let rows=baseRows();
    for(const field of scheduleFilterFields)rows=applyScheduleColumnFilter(rows,field);
    const sort=scheduleSortState.field, direction=scheduleSortState.direction==="desc"?-1:1;
    const field={id:r=>Number(r.schedule_id),time:r=>r.next_run_at||r.schedule_time||"",owner:r=>r.owner_name||r.owner_username||"",device:r=>r.device_name||r.device_id,channel:r=>r.output_signal,name:r=>r.schedule_name||"",action:r=>r.action_state,ostr:r=>r.ostr_payload||"",repeat:r=>repeatNames[r.repeat_type]||r.repeat_type,end:r=>r.end_time||"",created:r=>r.created_at||"",status:r=>scheduleColumnLabel(r,"status"),last_run:r=>r.last_run_at||""}[sort]||((r)=>r.next_run_at||r.schedule_time||"");
    return rows.sort((a,b)=>{const left=field(a),right=field(b);const comparison=typeof left==="number"?left-right:String(left).localeCompare(String(right),"ko",{numeric:true});return comparison*direction||Number(b.schedule_id)-Number(a.schedule_id);});
  }
  function renderColumnFilters(startIndex=0) {
    let availableRows=baseRows();
    for(const [index,field] of scheduleFilterFields.entries()) {
      if(index<startIndex){availableRows=applyScheduleColumnFilter(availableRows,field);continue;}
      const container=$(`#scheduleFilter${({id:"Id",owner:"Owner",device:"Device",channel:"Channel",name:"Name",action:"Action",ostr:"Ostr",repeat:"Repeat",next_run:"NextRun",end:"End",status:"Status",last_run:"LastRun",created:"Created"})[field]}`);
      const values=new Map();
      for(const row of availableRows)values.set(scheduleColumnValue(row,field),scheduleColumnLabel(row,field));
      let selected=scheduleColumnFilters.get(field);
      if(selected){const available=new Set(values.keys()),retained=new Set([...selected].filter(value=>available.has(value)));if(retained.size!==selected.size){if(selected.size>0&&retained.size===0)scheduleColumnFilters.delete(field);else scheduleColumnFilters.set(field,retained);selected=scheduleColumnFilters.get(field);}}
      const allSelected=!selected||(values.size>0&&selected.size===values.size);
      const options=[...values].sort((a,b)=>a[1].localeCompare(b[1],"ko",{numeric:true})).map(([value,label])=>`<label class="schedule-filter-option" data-filter-label="${esc(label.toLowerCase())}"><input type="checkbox" data-schedule-filter="${field}" value="${esc(value)}"${allSelected||selected.has(value)?" checked":""}><span>${esc(label)}</span></label>`).join("");
      const sortField=scheduleSortFields[field];
      const sortButtons=["asc","desc"].map(direction=>`<button type="button" data-schedule-sort="${field}" data-sort-direction="${direction}" aria-pressed="${scheduleSortState.field===sortField&&scheduleSortState.direction===direction}">${direction==="asc"?"오름차순":"내림차순"}</button>`).join("");
      container.innerHTML=`<button type="button" class="schedule-filter-trigger" data-schedule-filter-toggle="${field}" aria-label="${scheduleFilterLabels[field]} 필터" aria-expanded="false" title="${scheduleFilterLabels[field]} 필터"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14l-5.5 6.3v4.2l-3 1.5v-5.7L3 4Z"/></svg></button><div class="schedule-filter-menu" hidden><div class="schedule-filter-sort-actions">${sortButtons}</div><input type="search" data-schedule-filter-search="${field}" placeholder="값 검색" aria-label="필터 값 검색"><label class="schedule-filter-option schedule-filter-all"><input type="checkbox" data-schedule-filter-all="${field}"${allSelected?" checked":""}><span>모든 값</span></label><div class="schedule-filter-options">${options}</div></div>`;
      availableRows=applyScheduleColumnFilter(availableRows,field);
    }
  }
  function closeScheduleFilters() {
      for(const menu of document.querySelectorAll(".schedule-filter-menu:not([hidden])")){
        menu.hidden=true;
        menu.parentElement.querySelector("[data-schedule-filter-toggle]").setAttribute("aria-expanded","false");
      }
    }
    function positionScheduleFilterMenu(trigger,menu) {
      menu.hidden=false;trigger.setAttribute("aria-expanded","true");
      const bounds=trigger.getBoundingClientRect();
      menu.style.left=`${Math.max(8,Math.min(bounds.left,innerWidth-Math.min(menu.offsetWidth,280)-8))}px`;
      menu.style.top=`${Math.max(8,Math.min(bounds.bottom,innerHeight-Math.min(menu.offsetHeight,340)-8))}px`;
  }
  async function handleScheduleAction(event, anchor = null) {
    const edit=event.target.closest("[data-edit]"),del=event.target.closest("[data-delete]"),toggle=event.target.closest("[data-toggle]");
    try {
      if(edit){const row=allSchedules.find(item=>String(item.schedule_id)===edit.dataset.edit);if(row)editSchedule(row);}
      else if(del){const row=allSchedules.find(item=>String(item.schedule_id)===del.dataset.delete);if(await confirmScheduleDeletion(anchor||del,row)){await api(`/api/device/schedules/${del.dataset.delete}`,{method:"DELETE"});await loadSchedules();}}
      else if(toggle){await api(`/api/device/schedules/${toggle.dataset.toggle}/enabled`,{method:"PATCH",body:JSON.stringify({is_enabled:toggle.dataset.enabled==="1"})});await loadSchedules();}
    } catch(error) { alert(error.message); }
  }
  function closeScheduleActionMenu(restoreFocus=false) {
    if(actionMenu.matches(":popover-open"))actionMenu.hidePopover();
    actionTrigger?.setAttribute("aria-expanded","false");
    if(restoreFocus&&actionTrigger?.isConnected)actionTrigger.focus({preventScroll:true});
    actionTrigger=null;
  }
  function scheduleActionMarkup(row) {
    return `<button type="button" role="menuitem" tabindex="-1" data-edit="${row.schedule_id}">수정</button><button type="button" role="menuitem" tabindex="-1" data-toggle="${row.schedule_id}" data-enabled="${Number(row.is_enabled)===1?0:1}">${Number(row.is_enabled)===1?"중지":"활성"}</button><button type="button" role="menuitem" tabindex="-1" class="is-destructive" data-delete="${row.schedule_id}">삭제</button>`;
  }
  function openScheduleActionMenu(trigger) {
    const same=actionTrigger===trigger&&actionMenu.matches(":popover-open");
    closeScheduleActionMenu();
    if(same)return;
    const row=allSchedules.find(item=>String(item.schedule_id)===trigger.dataset.scheduleActions);
    if(!row)return;
    closeScheduleFilters();
    actionMenu.innerHTML=scheduleActionMarkup(row);
    actionTrigger=trigger;trigger.setAttribute("aria-expanded","true");
    actionMenu.showPopover({source:trigger});
    const bounds=trigger.getBoundingClientRect();
    actionMenu.style.left=`${Math.max(8,Math.min(bounds.right-actionMenu.offsetWidth,innerWidth-actionMenu.offsetWidth-8))}px`;
    actionMenu.style.top=`${Math.max(8,Math.min(bounds.bottom+4,innerHeight-actionMenu.offsetHeight-8))}px`;
    actionMenu.querySelector("button")?.focus({preventScroll:true});
  }
  function renderTable() {
    closeScheduleActionMenu();
    const rows=currentRows();$("#scheduleCount").textContent=`${rows.length}건`;
    rowsRoot.innerHTML=rows.length?rows.map(r=>`<tr>
      <td>${r.schedule_id}</td><td>${esc(r.owner_name||r.owner_username||`ID ${r.created_by??"-"}`)}</td><td><strong>${esc(r.device_name||r.device_id)}${r.device_is_visible==null||Number(r.device_is_visible)===1?"":" · Invisible"}${Number(r.device_is_enabled)===1?"":" · 비활성"}</strong><small>${esc(r.device_id)}</small></td><td>${esc(r.output_signal)}${r.channel_is_visible==null||Number(r.channel_is_visible)===1?"":" · Invisible"}</td><td>${esc(r.schedule_name||"-")}</td><td><span class="schedule-state ${r.action_state==='ON'?'state-on':'state-off'}">${esc(r.action_state)}</span></td><td class="schedule-ostr">${esc(r.ostr_payload||"")}</td><td>${esc(repeatNames[r.repeat_type]||r.repeat_type)}</td><td>${esc(formatDate(["ONCE","IMMEDIATE"].includes(r.repeat_type)&&Number(r.is_enabled)!==1?null:r.next_run_at||r.schedule_time))}</td><td>${esc(formatDate(r.end_time))}</td><td>${esc(r.last_execution_status||"WAITING")}${Number(r.is_enabled)!==1?" · 비활성":" · 활성"}</td><td>${esc(formatDate(r.last_run_at))}<small>${esc(r.last_execution_message==="조회 전용 채널은 웹에서 제어할 수 없습니다."?"":r.last_execution_message||"")}</small></td><td>${esc(formatDate(r.created_at))}</td><td class="schedule-row-actions"><button type="button" class="schedule-action-trigger" data-schedule-actions="${r.schedule_id}" aria-label="예약 ${r.schedule_id} 관리 메뉴" title="예약 관리" aria-haspopup="menu" aria-controls="scheduleActionMenu" aria-expanded="false"><span aria-hidden="true">&#8943;</span></button></td></tr>`).join(""):'<tr><td colspan="14" class="schedule-empty">조건에 맞는 예약이 없습니다.</td></tr>';
  }
  function formPayload() {
    const fd=new FormData(form), type=fd.get("repeat_type"), data={device_id:fd.get("device_id"),output_signal:fd.get("output_signal"),schedule_name:fd.get("schedule_name"),action_state:fd.get("action_state"),repeat_type:type,schedule_time:type==="IMMEDIATE"?"":fd.get("schedule_time"),end_time:["ONCE","IMMEDIATE"].includes(type)?"":fd.get("end_time"),ostr_payload:fd.get("ostr_payload")};
    if(type==="WEEKLY")data.weekdays=fd.getAll("weekdays");
    if(type==="MONTHLY")data.is_month_end=form.elements.is_month_end.checked;
    return data;
  }
  function resetForm() {form.reset();form.elements.schedule_id.value="";$("#scheduleFormTitle").textContent="새 예약 등록";$("#scheduleSubmit").textContent="예약 등록";$("#scheduleCancel").hidden=true;$("#scheduleValidationMessage").textContent="";$("#scheduleMessage").textContent="";setRepeatFields();}
  function editSchedule(r) {
    resetForm();form.elements.schedule_id.value=r.schedule_id;$("#scheduleDevice").value=r.device_id;updateChannels();$("#scheduleChannel").value=r.output_signal;
    for(const key of ["schedule_name","action_state","repeat_type","ostr_payload","end_time"])if(form.elements[key])form.elements[key].value=String(r[key]??"").replace(" ","T").slice(0,16);
    const executionTime=r.schedule_time||r.next_run_at||r.last_run_at;
    if(executionTime)form.elements.schedule_time.value=String(executionTime).replace(" ","T").slice(0,16);
    form.elements.is_month_end.checked=Number(r.is_month_end)===1;
    const mask=Number(r.weekday_mask||0);form.querySelectorAll('input[name="weekdays"]').forEach(el=>el.checked=!!(mask&(1<<Number(el.value))));
    $("#scheduleFormTitle").textContent=`Skedule ID: ${r.schedule_id} 수정중`;$("#scheduleSubmit").textContent="수정 완료";$("#scheduleCancel").hidden=false;setRepeatFields();form.scrollIntoView({behavior:"smooth",block:"start"});
  }
  function confirmScheduleDeletion(button, schedule) {
    return new Promise(resolve => {
      const dialog=document.createElement("dialog");
      dialog.className="schedule-delete-dialog";
      dialog.setAttribute("aria-labelledby","scheduleDeleteTitle");
      dialog.setAttribute("aria-describedby","scheduleDeleteDescription");
      dialog.innerHTML='<h3 id="scheduleDeleteTitle">예약 삭제</h3><p id="scheduleDeleteDescription"></p><div class="schedule-delete-actions"><button type="button" data-cancel-delete autofocus>취소</button><button type="button" data-confirm-delete>삭제</button></div>';
      dialog.querySelector("p").textContent=`예약 #${schedule?.schedule_id??button.dataset.delete} (${schedule?.device_id||""} / ${schedule?.output_signal||""})을 삭제하시겠습니까?`;
      const position=()=>{
        const anchor=button.getBoundingClientRect(), bounds=dialog.getBoundingClientRect();
        const left=Math.max(8,Math.min(anchor.right-bounds.width,window.innerWidth-bounds.width-8));
        const top=anchor.bottom+8+bounds.height<=window.innerHeight-8?anchor.bottom+8:Math.max(8,anchor.top-bounds.height-8);
        dialog.style.left=`${left}px`;dialog.style.top=`${top}px`;
      };
      const finish=confirmed=>{
        window.removeEventListener("resize",position);
        window.removeEventListener("scroll",position,true);
        dialog.close();dialog.remove();
        if(button.isConnected)button.focus({preventScroll:true});
        resolve(confirmed);
      };
      dialog.querySelector("[data-cancel-delete]").addEventListener("click",()=>finish(false));
      dialog.querySelector("[data-confirm-delete]").addEventListener("click",()=>finish(true));
      dialog.addEventListener("cancel",event=>{event.preventDefault();finish(false);});
      dialog.addEventListener("click",event=>{
        if(event.target!==dialog)return;
        const bounds=dialog.getBoundingClientRect();
        if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)finish(false);
      });
      document.body.append(dialog);dialog.showModal();position();
      window.addEventListener("resize",position);
      window.addEventListener("scroll",position,true);
    });
  }
  form.addEventListener("invalid",event=>{if(event.target.required)$("#scheduleValidationMessage").textContent="목록에서 항목을 선택하세요.";},true);
  const clearValidationMessage=()=>{const requiredFieldsValid=[...form.querySelectorAll("[required]")].every(field=>field.validity.valid),weekdaysValid=$("#repeatType").value!=="WEEKLY"||!!form.querySelector('input[name="weekdays"]:checked');if(requiredFieldsValid&&weekdaysValid)$("#scheduleValidationMessage").textContent="";};
  form.addEventListener("input",clearValidationMessage);form.addEventListener("change",clearValidationMessage);
  form.addEventListener("submit",async e=>{e.preventDefault();const validationMessage=$("#scheduleValidationMessage");if($("#repeatType").value==="WEEKLY"&&!form.querySelector('input[name="weekdays"]:checked')){validationMessage.textContent="목록에서 항목을 선택하세요.";return;}validationMessage.textContent="";const msg=$("#scheduleMessage");msg.textContent="저장 중...";try{const data=formPayload(),id=form.elements.schedule_id.value;await api(id?`/api/device/schedules/${id}`:"/api/device/schedules",{method:id?"PUT":"POST",body:JSON.stringify(data)});msg.textContent="저장되었습니다.";resetForm();await loadSchedules();}catch(err){msg.textContent=err.message;}});
  $("#scheduleDevice").addEventListener("change",updateChannels);$("#repeatType").addEventListener("change",setRepeatFields);$("#scheduleCancel").addEventListener("click",resetForm);
  document.querySelector(".schedule-table thead").addEventListener("change",event=>{
    const field=event.target.dataset.scheduleFilter,allField=event.target.dataset.scheduleFilterAll;
    if(allField){
      const options=[...document.querySelectorAll(`[data-schedule-filter="${allField}"]`)];
      if(event.target.checked){scheduleColumnFilters.delete(allField);options.forEach(input=>{input.checked=true;});}
      else{scheduleColumnFilters.set(allField,new Set());options.forEach(input=>{input.checked=false;});}
      renderColumnFilters(scheduleFilterFields.indexOf(allField)+1);renderTable();return;
    }
    if(!field)return;
    const selected=new Set([...document.querySelectorAll(`[data-schedule-filter="${field}"]:checked`)].map(input=>input.value));
    const optionCount=document.querySelectorAll(`[data-schedule-filter="${field}"]`).length;
    if(selected.size===optionCount)scheduleColumnFilters.delete(field);else scheduleColumnFilters.set(field,selected);
    event.target.closest(".schedule-filter-menu").querySelector("[data-schedule-filter-all]").checked=selected.size===optionCount;
    renderColumnFilters(scheduleFilterFields.indexOf(field)+1);renderTable();
  });
  document.querySelector(".schedule-table thead").addEventListener("input",event=>{
    const field=event.target.dataset.scheduleFilterSearch;if(!field)return;
    const search=event.target.value.trim().toLowerCase();
    for(const option of document.querySelectorAll(`#scheduleFilter${({id:"Id",owner:"Owner",device:"Device",channel:"Channel",name:"Name",action:"Action",ostr:"Ostr",repeat:"Repeat",next_run:"NextRun",end:"End",status:"Status",last_run:"LastRun",created:"Created"})[field]} .schedule-filter-option[data-filter-label]`))option.hidden=!option.dataset.filterLabel.includes(search);
  });
  document.querySelector(".schedule-table thead").addEventListener("click",event=>{
    const sortButton=event.target.closest("[data-schedule-sort]");
    if(sortButton){scheduleSortState.field=scheduleSortFields[sortButton.dataset.scheduleSort];scheduleSortState.direction=sortButton.dataset.sortDirection;closeScheduleFilters();renderColumnFilters();renderTable();return;}
    const trigger=event.target.closest("[data-schedule-filter-toggle]");if(!trigger)return;
    const menu=trigger.parentElement.querySelector(".schedule-filter-menu"),wasOpen=!menu.hidden;
    closeScheduleFilters();if(!wasOpen)positionScheduleFilterMenu(trigger,menu);
  });
  document.addEventListener("pointerdown",event=>{if(!event.target.closest(".schedule-column-filter"))closeScheduleFilters();});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")closeScheduleFilters();});
  window.addEventListener("scroll",closeScheduleFilters,true);window.addEventListener("resize",closeScheduleFilters);
  rowsRoot.addEventListener("click",event=>{const trigger=event.target.closest("[data-schedule-actions]");if(trigger)openScheduleActionMenu(trigger);});
  actionMenu.addEventListener("click",event=>{if(!event.target.closest("[data-edit],[data-toggle],[data-delete]"))return;const anchor=actionTrigger;closeScheduleActionMenu(true);void handleScheduleAction(event,anchor);});
  actionMenu.addEventListener("toggle",event=>{if(event.newState==="closed"&&!actionMenu.matches(":popover-open"))closeScheduleActionMenu();});
  actionMenu.addEventListener("keydown",event=>{
    const buttons=[...actionMenu.querySelectorAll("button")],index=buttons.indexOf(document.activeElement);
    if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
    if(event.key==="Escape"||event.key==="Tab"){if(event.key==="Escape")event.preventDefault();closeScheduleActionMenu(true);}
  });
  window.addEventListener("scroll",event=>{if(!(event.target instanceof Node)||!actionMenu.contains(event.target))closeScheduleActionMenu();},true);
  window.addEventListener("resize",()=>closeScheduleActionMenu());
  setRepeatFields();Promise.all([loadDevices(),loadSchedules()]).catch(err=>{$("#scheduleMessage").textContent=err.message;rowsRoot.innerHTML=`<tr><td colspan="14">${esc(err.message)}</td></tr>`;});
})();
