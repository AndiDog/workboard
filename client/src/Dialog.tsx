import { Component, ComponentChildren, createRef } from 'preact';
import BootstrapDialog from 'bootstrap/js/dist/dialog.js';

type DialogProps = {
  children: ComponentChildren;
  footer: ComponentChildren;
  onExited?: () => void;
  onHide: () => void;
  scrollable?: boolean;
  show: boolean;
  size?: 'sm' | 'lg' | 'xl';
  title: string;
};

// Bootstrap dialog with props like react-bootstrap's `Modal`, so it can be swapped later
export default class Dialog extends Component<DialogProps> {
  bootstrapDialog?: BootstrapDialog;
  dialogRef = createRef<HTMLDialogElement>();

  componentDidMount() {
    const dialogElement = this.dialogRef.current;
    if (dialogElement === null) {
      return;
    }

    dialogElement.addEventListener('hide.bs.dialog', this.onBootstrapHide);
    dialogElement.addEventListener('hidden.bs.dialog', this.onBootstrapHidden);
    dialogElement.addEventListener('shown.bs.dialog', this.onBootstrapShown);

    this.bootstrapDialog = new BootstrapDialog(dialogElement);
    if (this.props.show) {
      this.bootstrapDialog.show();
    }
  }

  componentDidUpdate(previousProps: DialogProps) {
    if (this.props.show == previousProps.show) {
      return;
    }

    if (this.props.show) {
      this.bootstrapDialog?.show();
    } else {
      this.bootstrapDialog?.hide();
    }
  }

  componentWillUnmount() {
    this.bootstrapDialog?.dispose();
  }

  onBootstrapHide = (event: Event) => {
    // Escape key or backdrop click only requests hiding. The `show` prop decides.
    if (this.props.show) {
      event.preventDefault();
      this.props.onHide();
    }
  };

  onBootstrapHidden = () => {
    // `show` changed during the transition, which Bootstrap ignores
    if (this.props.show) {
      this.bootstrapDialog?.show();
      return;
    }

    this.props.onExited?.();
  };

  onBootstrapShown = () => {
    // `show` changed during the transition, which Bootstrap ignores
    if (!this.props.show) {
      this.bootstrapDialog?.hide();
    }
  };

  render() {
    let className = 'dialog';
    if (this.props.size !== undefined) {
      className += ` dialog-${this.props.size}`;
    }
    if (this.props.scrollable) {
      className += ' dialog-scrollable';
    }

    return (
      <dialog
        ref={this.dialogRef}
        className={className}
        aria-label={this.props.title}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">{this.props.title}</h2>
        </div>
        <div className="dialog-body">{this.props.children}</div>
        <div className="dialog-footer">{this.props.footer}</div>
      </dialog>
    );
  }
}
