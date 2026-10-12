import { Component } from 'preact';
import { CodeReview } from './generated/workboard';
import {
  CodeReviewInfoCells,
  CodeReviewInfoColumns,
  SignalColumnHeaders,
  simplePlural,
} from './codeReviewDisplay';
import Dialog from './Dialog';

type DeleteCodeReviewsDialogProps = {
  codeReviews: CodeReview[];
  onDelete: () => void;
  onExited: () => void;
};

type DeleteCodeReviewsDialogState = {
  show: boolean;
};

export default class DeleteCodeReviewsDialog extends Component<
  DeleteCodeReviewsDialogProps,
  DeleteCodeReviewsDialogState
> {
  state: DeleteCodeReviewsDialogState = {
    show: true,
  };

  onDelete(event: Event) {
    event.preventDefault();

    this.props.onDelete();
    this.setState({ show: false });
  }

  onHide() {
    this.setState({ show: false });
  }

  render() {
    const numCodeReviews = this.props.codeReviews.length;

    return (
      <Dialog
        show={this.state.show}
        onHide={() => this.onHide()}
        onExited={this.props.onExited}
        scrollable
        size="xl"
        title={`Delete ${numCodeReviews} ${simplePlural(numCodeReviews, 'code review')}?`}
        footer={
          <>
            <button
              className="btn btn-solid theme-danger"
              autoFocus
              onClick={(event) => this.onDelete(event)}
            >
              Delete
            </button>
            <button
              className="btn btn-outline theme-secondary"
              onClick={() => this.onHide()}
            >
              Cancel
            </button>
          </>
        }
      >
        <table className="pull-requests">
          <colgroup>
            <CodeReviewInfoColumns />
          </colgroup>
          <thead>
            <tr>
              <SignalColumnHeaders />
              <th colSpan={2}>Pull request</th>
            </tr>
          </thead>
          <tbody>
            {this.props.codeReviews.map((codeReview) => (
              <tr key={codeReview.id}>
                <CodeReviewInfoCells codeReview={codeReview} />
              </tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    );
  }
}
