(() => {
  const $ = (selector) => document.querySelector(selector);
  const form = $("#scheduleForm"), rowsRoot = $("#scheduleRows");
  let allSchedules = [], devices = [];
  const repeatNames = { ONCE:"1회", HOURLY:"매시간", DAILY:"매일", WEEKLY:"반복 요일", MONTHLY:"매월", YEARLY:"매년" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const formatDate = value => value ? String(value).replace("T"," ").slice(0,16) : "-";
  async function api(url, options={}) { const r=await fetch(url,{cache:"no-store",headers:{"Content-Type":"application/json",...(options.headers||{})},...options}); const data=await r.json().catch(()=>({})); if(!r.ok)throw new Error(data.error||`요청 실패 (${r.status})`); return data; }
  function setRepeatFields() {
    const type=$("#repeatType").value;
    const visible={weekdays:type==="WEEKLY",is_month_end:type==="MONTHLY"};
    Object.entries(visible).forEach(([key,show])=>{const el=form.querySelector(`[data-field="${key}"]`);if(el)el.hidden=!show;});
    if(type!=="WEEKLY")form.querySelectorAll('input[name="weekdays"]').forEach(el=>el.checked=false);
    if(type!=="MONTHLY")form.elements.is_month_end.checked=false;
  }
  function fillSelect(select, values, firstLabel, valueKey, labelKey) { const current=select.value;select.innerHTML=`<option value="">${firstLabel}</option>`+values.map(v=>`<option value="${esc(v[valueKey])}">${esc(v[labelKey])}</option>`).join("");if([...select.options].some(o=>o.value===current))select.value=current; }
  async function loadDevices() {
    devices=await api("/api/device/devices");
    fillSelect($("#scheduleDevice"),devices,"디바이스 선택","device_id","device_name");
    fillSelect($("#filterDevice"),devices,"전체 디바이스","device_id","device_name");
    updateChannels();
  }
  function updateChannels() {
    const device=devices.find(d=>d.device_id===$("#scheduleDevice").value);
    const channels=(device?.sets||[]).map(c=>({value:c.output_signal,label:`${c.channel_name} (${c.output_signal})`}));
    const select=$("#scheduleChannel"), current=select.value;select.innerHTML='<option value="">채널 선택</option>'+channels.map(c=>`<option value="${esc(c.value)}">${esc(c.label)}</option>`).join("");if(channels.some(c=>c.value===current))select.value=current;
    const channelOptions=[...new Map(devices.flatMap(d=>(d.sets||[]).map(c=>[c.output_signal,{value:c.output_signal,label:c.output_signal}]))).values()];fillSelect($("#filterChannel"),channelOptions,"전체 채널","value","label");
  }
  async function loadSchedules() {
    const data=await api("/api/device/schedules?limit=5000&sort_by=time&sort_order=asc");allSchedules=Array.isArray(data.items)?data.items:[];
    const owners=[...new Map(allSchedules.map(s=>[String(s.created_by),{value:String(s.created_by??""),label:s.owner_name||s.owner_username||`ID ${s.created_by}`}])).values()].filter(o=>o.value);
    fillSelect($("#filterOwner"),owners,"전체 예약자","value","label");renderTable();
  }
  function currentRows() {
    const q=$("#filterSearch").value.trim().toLowerCase(), owner=$("#filterOwner").value, device=$("#filterDevice").value, channel=$("#filterChannel").value, action=$("#filterAction").value, repeat=$("#filterRepeat").value, enabled=$("#filterEnabled").value, start=$("#filterStart").value, end=$("#filterEnd").value;
    const sort=$("#sortBy").value, direction=$("#sortOrder").value==="desc"?-1:1;
    const field={time:r=>r.next_run_at||r.schedule_time||"",owner:r=>r.owner_name||r.owner_username||"",device:r=>r.device_name||r.device_id,channel:r=>r.output_signal,action:r=>r.action_state,repeat:r=>r.repeat_type,created:r=>r.created_at||"",status:r=>r.last_execution_status||""}[sort];
    return allSchedules.filter(r=>{const text=[r.schedule_id,r.schedule_name,r.owner_name,r.owner_username,r.device_name,r.device_id,r.output_signal,r.action_state,r.ostr_payload,r.repeat_type,r.last_execution_status].join(" ").toLowerCase();const date=String(r.next_run_at||r.schedule_time||"").slice(0,10);return (!q||text.includes(q))&&(!owner||String(r.created_by)===owner)&&(!device||r.device_id===device)&&(!channel||r.output_signal===channel)&&(!action||r.action_state===action)&&(!repeat||r.repeat_type===repeat)&&(enabled===""||(enabled==="1"?Number(r.is_enabled)===1:Number(r.is_enabled)!==1))&&(!start||date>=start)&&(!end||date<=end);}).sort((a,b)=>String(field(a)).localeCompare(String(field(b)),"ko",{numeric:true})*direction||Number(b.schedule_id)-Number(a.schedule_id));
  }
  function renderTable() {
    const rows=currentRows();$("#scheduleCount").textContent=`${rows.length}건`;
    rowsRoot.innerHTML=rows.length?rows.map(r=>`<tr>
      <td>${r.schedule_id}</td><td>${esc(r.owner_name||r.owner_username||`ID ${r.created_by??"-"}`)}</td><td><strong>${esc(r.device_name||r.device_id)}</strong><small>${esc(r.device_id)}</small></td><td>${esc(r.output_signal)}</td><td><span class="schedule-state ${r.action_state==='ON'?'state-on':'state-off'}">${esc(r.action_state)}</span></td><td class="schedule-ostr">${esc(r.ostr_payload||"")}</td><td>${esc(repeatNames[r.repeat_type]||r.repeat_type)}</td><td>${esc(formatDate(r.repeat_type==="ONCE"&&Number(r.is_enabled)!==1?null:r.next_run_at||r.schedule_time))}</td><td>${esc(r.last_execution_status||"WAITING")}${Number(r.is_enabled)!==1?" · 비활성":" · 활성"}</td><td>${esc(formatDate(r.last_run_at))}<small>${esc(r.last_execution_message||"")}</small></td><td>${esc(formatDate(r.created_at))}</td><td class="schedule-row-actions"><button type="button" data-edit="${r.schedule_id}">수정</button><button type="button" data-toggle="${r.schedule_id}" data-enabled="${Number(r.is_enabled)===1?0:1}">${Number(r.is_enabled)===1?"중지":"활성"}</button><button type="button" data-delete="${r.schedule_id}">삭제</button></td></tr>`).join(""):'<tr><td colspan="12" class="schedule-empty">조건에 맞는 예약이 없습니다.</td></tr>';
  }
  function formPayload() {
    const fd=new FormData(form), type=fd.get("repeat_type"), data={device_id:fd.get("device_id"),output_signal:fd.get("output_signal"),schedule_name:fd.get("schedule_name"),action_state:fd.get("action_state"),repeat_type:type,schedule_time:fd.get("schedule_time"),ostr_payload:fd.get("ostr_payload"),is_enabled:form.elements.is_enabled.checked};
    if(type==="WEEKLY")data.weekdays=fd.getAll("weekdays");
    if(type==="MONTHLY")data.is_month_end=form.elements.is_month_end.checked;
    return data;
  }
  function resetForm() {form.reset();form.elements.schedule_id.value="";$("#scheduleFormTitle").textContent="새 예약 등록";$("#scheduleSubmit").textContent="예약 등록";$("#scheduleCancel").hidden=true;$("#scheduleValidationMessage").textContent="";$("#scheduleMessage").textContent="";setRepeatFields();}
  function editSchedule(r) {
    resetForm();form.elements.schedule_id.value=r.schedule_id;$("#scheduleDevice").value=r.device_id;updateChannels();$("#scheduleChannel").value=r.output_signal;
    for(const key of ["schedule_name","action_state","repeat_type","ostr_payload"])if(form.elements[key])form.elements[key].value=r[key]??"";
    const executionTime=r.schedule_time||r.next_run_at||r.last_run_at;
    if(executionTime)form.elements.schedule_time.value=String(executionTime).replace(" ","T").slice(0,16);
    form.elements.is_month_end.checked=Number(r.is_month_end)===1;form.elements.is_enabled.checked=true;
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
      dialog.querySelector("p").textContent=`예약 #${button.dataset.delete} (${schedule?.device_id||""} / ${schedule?.output_signal||""})을 삭제하시겠습니까?`;
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
  ["#filterSearch","#filterOwner","#filterDevice","#filterChannel","#filterAction","#filterRepeat","#filterEnabled","#filterStart","#filterEnd","#sortBy","#sortOrder"].forEach(sel=>$(sel).addEventListener(sel==="#filterSearch"?"input":"change",renderTable));
  $("#resetFilters").addEventListener("click",()=>{["#filterSearch","#filterOwner","#filterDevice","#filterChannel","#filterAction","#filterRepeat","#filterEnabled","#filterStart","#filterEnd"].forEach(sel=>$(sel).value="");$("#sortBy").value="time";$("#sortOrder").value="asc";renderTable();});
  rowsRoot.addEventListener("click",async e=>{const edit=e.target.closest("[data-edit]"),del=e.target.closest("[data-delete]"),toggle=e.target.closest("[data-toggle]");try{if(edit){const r=allSchedules.find(x=>String(x.schedule_id)===edit.dataset.edit);if(r)editSchedule(r);}else if(del){const r=allSchedules.find(x=>String(x.schedule_id)===del.dataset.delete);if(await confirmScheduleDeletion(del,r)){await api(`/api/device/schedules/${del.dataset.delete}`,{method:"DELETE"});await loadSchedules();}}else if(toggle){await api(`/api/device/schedules/${toggle.dataset.toggle}/enabled`,{method:"PATCH",body:JSON.stringify({is_enabled:toggle.dataset.enabled==="1"})});await loadSchedules();}}catch(err){alert(err.message);}});
  setRepeatFields();Promise.all([loadDevices(),loadSchedules()]).catch(err=>{$("#scheduleMessage").textContent=err.message;rowsRoot.innerHTML=`<tr><td colspan="12">${esc(err.message)}</td></tr>`;});
})();
