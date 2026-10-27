<script lang="ts">
  import Icon from "../icon.svelte";
  let { title, menuId, onselect } = $props<{
    title: string;
    menuId: string;
    onselect: () => void;
  }>();
</script>

<button
  class="button only-mobile"
  data-variant="secondary"
  commandfor={menuId}
  command="show-modal"
  aria-label={`Actions for ${title}`}
  onclick={onselect}><Icon name="menu" size={24} /></button
>
<button
  class="button only-desktop"
  data-variant="secondary"
  commandfor={`${menuId}-popover`}
  command="toggle-popover"
  aria-label={`Actions for ${title}`}
  onclick={onselect}><Icon name="menu" size={24} /></button
>
